"""Apply the narrowly scoped business write barrier to Etherpad v3.3.6."""

from pathlib import Path

path = Path('/opt/etherpad-lite/src/node/handler/PadMessageHandler.ts')
source = path.read_text()


def replace_once(before: str, after: str) -> None:
    global source
    if source.count(before) != 1:
        raise SystemExit(f'Expected one Etherpad v3.3.6 anchor, found {source.count(before)}: {before[:80]}')
    source = source.replace(before, after, 1)


replace_once(
    'const padChannels = new Channels((ch, {socket, message}) => handleUserChanges(socket, message, ch));',
    '''const padChannels = new Channels((ch, task) =>
  typeof task === 'function' ? task(ch) : handleUserChanges(task.socket, task.message, ch));

// The closure service uses the same ordered channel as USER_CHANGES.
exports.enqueueBusinessBarrier = async (padId: string): Promise<number> =>
  await padChannels.enqueue(padId, async () => {
    const pad = await padManager.getPad(padId);
    return pad.getHeadRevisionNumber();
  });''',
)

replace_once(
    '    const {data: {baseRev, apool, changeset}} = message;',
    '''    // Admission occurs in the pad queue, immediately before applying the change.
    // A pre-queue handleMessage hook cannot establish a closure barrier.
    const decisions = await hooks.aCallAll('businessBeforeUserChanges', {
      padId: authorizedPadId, socket, message, authorId: thisSession.author,
    });
    if (decisions.length === 0 || decisions.some((decision: unknown) => decision !== true)) {
      socket.emit('message', {type: 'COLLABROOM', data: {
        type: 'CLIENT_MESSAGE', payload: {type: 'businessWriteRejected', reason: 'WRITE_NOT_ADMITTED'},
      }});
      return;
    }
    const {data: {baseRev, apool, changeset}} = message;''',
)

path.write_text(source)
