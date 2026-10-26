import Fastify from 'fastify';
import {readFileSync} from 'node:fs';
import {fromNodeHeaders} from 'better-auth/node';
import {loadConfig} from './config.js';
import {pool} from './database.js';
import {EtherpadClient} from './etherpad.js';
import {assertTimeZone} from './domain/calendar.js';
import {createLocalSession, createVerifiedSession, internalKeyMatches, requireUser, requireVerifiedUser, sessionCookie} from './domain/auth.js';
import {auth} from './better-auth.js';
import {localMessages} from './email.js';
import {InvitationService} from './domain/invitations.js';
import {DomainError} from './domain/errors.js';
import {BusinessService} from './domain/service.js';
import {WriteCreditService} from './domain/credit.js';
import {DownloadService} from './domain/downloads.js';

const config = loadConfig();
// The load balancer routes /backend/* to the backends on the same port as the web pages, so the
// browser stays on one origin. The prefix is removed before routing; direct calls are unchanged.
function stripBackendPrefix(url: string | undefined): string {
  const stripped = (url ?? '/').replace(/^\/backend(?=[/?]|$)/, '');
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}
const app = Fastify({logger: true, rewriteUrl: (request) => stripBackendPrefix(request.url)});
const etherpadClient = new EtherpadClient(config);
const service = new BusinessService(etherpadClient, config.internalKey, config.etherpadApiUrl);
const credit = new WriteCreditService();
const downloads = new DownloadService(etherpadClient);
const invitations = new InvitationService(process.env.AUTH_BASE_URL ?? 'http://127.0.0.1:3000',
  Number(process.env.INVITATION_LIFETIME_DAYS ?? '7'));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new DomainError(400, 'INVALID_ID', 'A valid ID is required');
  return value;
}
function key(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new DomainError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must have 8 to 128 characters');
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError(400, 'INVALID_BODY', 'A JSON object is required');
  }
  return value as Record<string, unknown>;
}
function params(value: unknown): Record<string, string> { return value as Record<string, string>; }
function editorUrl(padId: string): string {
  return new URL(`/p/${encodeURIComponent(padId)}`, config.etherpadPublicUrl).toString();
}

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof DomainError) return reply.code(error.status).send({error: {code: error.code, message: error.message}});
  app.log.error(error);
  return reply.code(502).send({error: {code: 'DEPENDENCY_FAILURE', message: 'A required service is unavailable'}});
});

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return {status: 'ok', quota: 'DAILY_WRITE_CREDIT', authentication: config.localDevelopment ? 'LOCAL_ONLY' : 'UNAVAILABLE'};
});
app.get('/app', async (_request, reply) =>
  reply.type('text/html; charset=utf-8').send(readFileSync(new URL('../public/app.html', import.meta.url), 'utf8')));

app.route({
  method: ['GET', 'POST'], url: '/api/auth/*',
  async handler(request, reply) {
    const url = new URL(request.url, process.env.AUTH_BASE_URL ?? 'http://127.0.0.1:3000');
    const response = await auth.handler(new Request(url, {
      method: request.method,
      headers: fromNodeHeaders(request.headers),
      ...(request.method === 'POST' ? {body: JSON.stringify(request.body ?? {})} : {}),
    }));
    reply.code(response.status);
    response.headers.forEach((value, name) => reply.header(name, value));
    return reply.send(response.body ? await response.text() : null);
  },
});

app.post('/auth/complete', async (request, reply) => {
  const session = await auth.api.getSession({headers: fromNodeHeaders(request.headers)});
  if (!session?.user.emailVerified) {
    throw new DomainError(401, 'EMAIL_NOT_VERIFIED', 'Email verification is required');
  }
  const businessSession = await createVerifiedSession(session.user.name, session.user.email);
  return reply.header('set-cookie', sessionCookie(businessSession.token)).send({userId: businessSession.userId});
});

app.get('/dev/mailbox', async (request) => {
  if (!config.localDevelopment || !internalKeyMatches(
    request.headers['x-internal-key'] as string | undefined, config.internalKey)) {
    throw new DomainError(403, 'FORBIDDEN', 'Local mailbox access is denied');
  }
  const email = (request.query as {email?: string}).email;
  if (typeof email !== 'string') throw new DomainError(400, 'INVALID_EMAIL', 'Email is required');
  return localMessages(email);
});

app.post('/dev/sessions', async (request, reply) => {
  if (!config.localDevelopment) throw new DomainError(404, 'NOT_FOUND', 'Route not found');
  const body = object(request.body);
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > 100 ||
      typeof body.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
    throw new DomainError(400, 'INVALID_IDENTITY', 'A name and email are required');
  }
  // Local mode only: "verified" skips the e-mail code. The declared address is not proven, which is
  // already the case for any local session, so this route must never be exposed publicly.
  const session = body.verified === true
    ? await createVerifiedSession(body.name, body.email)
    : await createLocalSession(body.name, body.email);
  return reply.header('set-cookie', sessionCookie(session.token)).code(201).send({userId: session.userId});
});

app.post('/documents', async (request, reply) => {
  if (!config.localDevelopment) throw new DomainError(404, 'NOT_FOUND', 'Route not found');
  const userId = await requireUser(request);
  const body = object(request.body);
  if (typeof body.title !== 'string' || body.title.trim().length < 1 || body.title.length > 200 ||
      typeof body.ownerTimeZone !== 'string') throw new DomainError(400, 'INVALID_DOCUMENT', 'Title and ownerTimeZone are required');
  try { assertTimeZone(body.ownerTimeZone); } catch { throw new DomainError(400, 'INVALID_TIME_ZONE', 'An IANA time zone is required'); }
  const document = await service.createDocument(userId, body.title.trim(), body.ownerTimeZone,
    key(request.headers['idempotency-key']));
  return reply.code(201).send({...document, editorUrl: editorUrl(document.padId)});
});

app.post('/projects', async (request, reply) => {
  const owner = (await requireVerifiedUser(request)).id;
  const body = object(request.body);
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 ||
      typeof body.ownerTimeZone !== 'string') {
    throw new DomainError(400, 'INVALID_PROJECT', 'Title and ownerTimeZone are required');
  }
  try { assertTimeZone(body.ownerTimeZone); } catch {
    throw new DomainError(400, 'INVALID_TIME_ZONE', 'An IANA time zone is required');
  }
  const project = await service.createDocument(owner, body.title.trim(), body.ownerTimeZone,
    key(request.headers['idempotency-key']));
  return reply.code(201).send({projectId: project.id, ...project, editorUrl: editorUrl(project.padId)});
});

app.get('/projects', async (request) => service.listProjects(await requireUser(request)));
app.get('/projects/:projectId', async (request) =>
  service.projectDetails(id(params(request.params).projectId), await requireUser(request)));
app.get('/projects/:projectId/branches', async (request) =>
  service.listBranches(id(params(request.params).projectId), await requireUser(request)));

app.post('/branches/:branchId/invitations', async (request, reply) => {
  const owner = await requireVerifiedUser(request);
  const body = object(request.body);
  if (typeof body.email !== 'string' || (body.access !== 'READ' && body.access !== 'WRITE')) {
    throw new DomainError(400, 'INVALID_INVITATION', 'Email and READ or WRITE access are required');
  }
  const result = await invitations.create(id(params(request.params).branchId), owner.id,
    body.email, body.access, key(request.headers['idempotency-key']));
  return reply.code(201).send(result);
});
app.get('/branches/:branchId/invitations', async (request) =>
  invitations.list(id(params(request.params).branchId), (await requireVerifiedUser(request)).id));
app.get('/branches/:branchId/collaborators', async (request) =>
  invitations.collaborators(id(params(request.params).branchId), (await requireVerifiedUser(request)).id));
app.put('/branches/:branchId/collaborators/:userId', async (request, reply) => {
  const access = object(request.body).access;
  if (access !== 'READ' && access !== 'WRITE') {
    throw new DomainError(400, 'INVALID_ACCESS', 'Access must be READ or WRITE');
  }
  await invitations.updateCollaborator(id(params(request.params).branchId),
    (await requireVerifiedUser(request)).id, id(params(request.params).userId), access);
  return reply.code(204).send();
});
app.delete('/branches/:branchId/collaborators/:userId', async (request, reply) => {
  await invitations.updateCollaborator(id(params(request.params).branchId),
    (await requireVerifiedUser(request)).id, id(params(request.params).userId), null);
  return reply.code(204).send();
});
app.post('/invitations/:invitationId/resend', async (request) => {
  const owner = await requireVerifiedUser(request);
  const body = request.body === undefined ? {} : object(request.body);
  if (body.access !== undefined && body.access !== 'READ' && body.access !== 'WRITE') {
    throw new DomainError(400, 'INVALID_ACCESS', 'Access must be READ or WRITE');
  }
  return invitations.resend(id(params(request.params).invitationId), owner.id, body.access);
});
app.delete('/invitations/:invitationId', async (request, reply) => {
  await invitations.revoke(id(params(request.params).invitationId), (await requireVerifiedUser(request)).id);
  return reply.code(204).send();
});
app.post('/invitations/preview', async (request) => {
  const token = object(request.body).token;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    throw new DomainError(400, 'INVALID_TOKEN', 'A valid invitation token is required');
  }
  return invitations.preview(token);
});
app.post('/invitations/accept', async (request) => {
  const token = object(request.body).token;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    throw new DomainError(400, 'INVALID_TOKEN', 'A valid invitation token is required');
  }
  const user = await requireVerifiedUser(request);
  return invitations.accept(token, user.id, user.email);
});

app.get('/documents/:documentId/branches', async (request) =>
  service.listBranches(id(params(request.params).documentId), await requireUser(request)));
app.get('/branches/:branchId/versions', async (request) =>
  service.listVersions(id(params(request.params).branchId), await requireUser(request)));
app.get('/versions/:versionId/content', async (request) => {
  const query = request.query as {revision?: string};
  const revision = query.revision === undefined ? undefined : Number(query.revision);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
    throw new DomainError(400, 'INVALID_REVISION', 'Revision must be a nonnegative integer');
  }
  return service.versionContent(id(params(request.params).versionId), await requireUser(request), revision);
});

app.put('/branches/:branchId/permissions/:userId', async (request, reply) => {
  if (!config.localDevelopment) throw new DomainError(404, 'NOT_FOUND', 'Route not found');
  const body = object(request.body);
  if (body.access !== 'READ' && body.access !== 'WRITE') throw new DomainError(400, 'INVALID_ACCESS', 'Access must be READ or WRITE');
  await service.setPermission(id(params(request.params).branchId), await requireUser(request),
    id(params(request.params).userId), body.access);
  return reply.code(204).send();
});
app.delete('/branches/:branchId/permissions/:userId', async (request, reply) => {
  if (!config.localDevelopment) throw new DomainError(404, 'NOT_FOUND', 'Route not found');
  await service.setPermission(id(params(request.params).branchId), await requireUser(request),
    id(params(request.params).userId), null);
  return reply.code(204).send();
});

app.post('/branches/:branchId/closures', async (request, reply) => {
  const closure = await service.requestClosure(id(params(request.params).branchId), await requireUser(request),
    'MANUAL', key(request.headers['idempotency-key']));
  return reply.code(202).send({operationId: closure.id, state: closure.state,
    admissionDeadline: closure.admission_deadline});
});
app.get('/closures/:operationId', async (request) => {
  const operation = await service.closure(id(params(request.params).operationId), await requireUser(request));
  return {operationId: operation.id, state: operation.state, finalRevision: operation.final_revision,
    successorVersionId: operation.successor_version_id, error: operation.last_error};
});

app.post('/versions/:versionId/restorations', async (request, reply) => {
  const body = object(request.body);
  if (!Number.isInteger(body.revision) || (body.revision as number) < 0) {
    throw new DomainError(400, 'INVALID_REVISION', 'A nonnegative revision is required');
  }
  const operation = await service.requestRestoration(id(params(request.params).versionId),
    await requireUser(request), body.revision as number, key(request.headers['idempotency-key']));
  return reply.code(202).send({operationId: operation.id, state: operation.state});
});
app.get('/restorations/:operationId', async (request) => {
  const operation = await service.restoration(id(params(request.params).operationId), await requireUser(request));
  return {operationId: operation.id, state: operation.state, destinationBranchId: operation.destination_branch_id,
    error: operation.last_error};
});

app.post('/internal/editor-access', async (request) => {
  if (!internalKeyMatches(request.headers['x-internal-key'] as string | undefined, config.internalKey)) {
    throw new DomainError(403, 'FORBIDDEN', 'Internal authorization is required');
  }
  const body = object(request.body);
  if (typeof body.padId !== 'string' || typeof body.sessionToken !== 'string' || typeof body.write !== 'boolean') {
    throw new DomainError(400, 'INVALID_BODY', 'padId, sessionToken, and write are required');
  }
  const access = await service.editorAccess(body.padId, body.sessionToken, body.write);
  if (body.write) {
    // Cost = characters inserted by the change, computed by the Etherpad plugin. Authorization
    // comes first, so only authorized writes are debited; a refused change is never applied.
    const cost = body.cost ?? 0;
    if (typeof cost !== 'number') throw new DomainError(400, 'INVALID_COST', 'cost must be a number');
    await credit.debit(access.userId, cost);
  }
  return access;
});

app.post('/branches/:branchId/download-links', async (request, reply) => {
  const userId = await requireUser(request);
  const body = object(request.body);
  const maxDownloads = typeof body.maxDownloads === 'number' ? body.maxDownloads : Number.NaN;
  const created = await downloads.createLink(userId, id(params(request.params).branchId), maxDownloads);
  const url = new URL(`/d/${created.token}`, process.env.AUTH_BASE_URL ?? 'http://127.0.0.1:3000').toString();
  return reply.code(201).send({linkId: created.id, url, maxDownloads});
});
app.get('/branches/:branchId/download-links', async (request) =>
  downloads.listLinks(await requireUser(request), id(params(request.params).branchId)));

// Public routes: visitors have no identity.
app.get('/d/:token/status', async (request) => downloads.status(params(request.params).token ?? ''));
app.get('/d/:token', async (request, reply) => {
  const result = await downloads.download(params(request.params).token ?? '');
  return reply.header('content-type', 'application/pdf')
    .header('content-disposition', 'attachment; filename="document.pdf"')
    .header('cache-control', 'no-store')
    .header('x-remaining-downloads', String(result.remaining))
    .send(result.pdf);
});

let working = false;
async function tick(): Promise<void> {
  if (working) return;
  working = true;
  try {
    await service.scheduleDaily();
    await service.processClosures();
    await service.processRestorations();
  } catch (error) { app.log.error(error, 'Background operation failed'); }
  finally { working = false; }
}

try {
  await pool.query('SELECT 1 FROM business.schema_migrations LIMIT 1');
  await app.listen({host: config.host, port: config.port});
  setInterval(() => void tick(), 1000).unref();
  await tick();
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
