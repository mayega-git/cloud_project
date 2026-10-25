'use strict';

const {readFileSync} = require('node:fs');
const {timingSafeEqual} = require('node:crypto');

const internalKey = readFileSync(process.env.INTERNAL_KEY_FILE, 'utf8').trim();
const backendUrl = process.env.BUSINESS_BACKEND_URL;
const monitoredSockets = new WeakSet();

function sessionToken(cookieHeader) {
  const part = (cookieHeader || '').split(';').map((item) => item.trim())
      .find((item) => item.startsWith('business_session='));
  return part ? part.slice('business_session='.length) : '';
}

async function access(padId, request, write) {
  const response = await fetch(new URL('/internal/editor-access', backendUrl), {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-internal-key': internalKey},
    body: JSON.stringify({padId, sessionToken: sessionToken(request.headers.cookie), write}),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) return null;
  return await response.json();
}

function padFromPath(path) {
  const match = /^\/p\/([^/]+)/.exec(path || '');
  try { return match ? decodeURIComponent(match[1]) : null; } catch { return null; }
}

exports.authenticate = async (_hook, context) => {
  const padId = padFromPath(context.req.path);
  if (!padId) return [false];
  const grant = await access(padId, context.req, false).catch(() => null);
  if (!grant) return [false];
  const username = grant.userId;
  if (!context.users[username]) context.users[username] = {};
  context.users[username].username = username;
  context.req.session.user = context.users[username];
  return [true];
};

exports.authorize = async (_hook, context) => {
  const padId = padFromPath(context.resource);
  if (!padId) return [false];
  const grant = await access(padId, context.req, false).catch(() => null);
  return [grant ? (grant.write && grant.state === 'OPEN' ? 'modify' : 'readOnly') : false];
};

exports.handleMessage = async (_hook, {message, sessionInfo, socket}) => {
  const padId = sessionInfo?.padId;
  if (!padId) return;
  if (!monitoredSockets.has(socket)) {
    monitoredSockets.add(socket);
    const timer = setInterval(async () => {
      const current = await access(padId, socket.request, false).catch(() => null);
      if (!current) socket.disconnect(true);
    }, 2000);
    socket.once('disconnect', () => clearInterval(timer));
  }
  const grant = await access(padId, socket.request, false).catch(() => null);
  if (!grant) {
    socket.disconnect(true);
    return null;
  }
  if (message?.type === 'CLIENT_READY' && (grant.state === 'CLOSING' || grant.state === 'FROZEN')) {
    socket.emit('message', {type: 'COLLABROOM', data: {
      type: 'CLIENT_MESSAGE', payload: {type: 'businessClosing', state: grant.state},
    }});
  }
};

exports.businessBeforeUserChanges = async (_hook, {padId, socket}) => {
  const grant = await access(padId, socket.request, true).catch(() => null);
  return !!grant;
};

exports.expressPreSession = (_hook, {app}) => {
  app.get('/business-status/:padId', async (request, response) => {
    const grant = await access(request.params.padId, request, false).catch(() => null);
    if (!grant) return response.status(403).json({error: 'FORBIDDEN'});
    return response.json({state: grant.state, write: grant.write});
  });
  app.post('/business-internal/barrier', async (request, response) => {
    const supplied = Buffer.from(request.headers['x-internal-key'] || '');
    const expected = Buffer.from(internalKey);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return response.status(403).json({error: 'FORBIDDEN'});
    }
    const padId = request.body?.padId;
    if (typeof padId !== 'string' || !/^business-[0-9a-f-]{36}$/.test(padId)) {
      return response.status(400).json({error: 'INVALID_PAD_ID'});
    }
    try {
      const handler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
      const revision = await handler.enqueueBusinessBarrier(padId);
      return response.json({revision});
    } catch (error) {
      console.error(error);
      return response.status(502).json({error: 'BARRIER_FAILED'});
    }
  });
};

