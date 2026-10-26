// Same-origin proxy to the backend: the browser never talks to it directly, so
// no CORS is needed and the session cookie stays on the frontend origin.
//
// Better Auth rejects POST requests whose Origin differs from its base URL, so
// the proxy presents the backend's own public origin (BACKEND_PUBLIC_ORIGIN,
// which must equal the origin of the backend's AUTH_BASE_URL).
const backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:3000';
const backendOrigin = process.env.BACKEND_PUBLIC_ORIGIN ?? backendUrl;

// Only the routes the interface needs. /internal/* and /dev/mailbox stay out.
const allowed = [
  'api/auth', 'auth/complete', 'projects', 'branches', 'invitations',
  'versions', 'closures', 'restorations',
];

const forwardedRequestHeaders = ['content-type', 'cookie', 'idempotency-key', 'accept'];

export const dynamic = 'force-dynamic';

async function forward(request: Request, context: {params: Promise<{path: string[]}>}): Promise<Response> {
  const {path} = await context.params;
  const joined = path.join('/');
  if (!allowed.some((prefix) => joined === prefix || joined.startsWith(`${prefix}/`))) {
    return Response.json({error: {code: 'NOT_FOUND', message: 'Route not found'}}, {status: 404});
  }

  const url = new URL(`/${joined}`, backendUrl);
  url.search = new URL(request.url).search;

  const headers = new Headers();
  for (const name of forwardedRequestHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('origin', backendOrigin);

  const init: RequestInit = {method: request.method, headers, redirect: 'manual', cache: 'no-store'};
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch {
    return Response.json({error: {code: 'BACKEND_UNREACHABLE', message: 'The backend is unreachable'}}, {status: 502});
  }

  const out = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) out.set('content-type', contentType);
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
  const body = upstream.status === 204 ? null : await upstream.arrayBuffer();
  return new Response(body, {status: upstream.status, headers: out});
}

export {forward as GET, forward as POST, forward as PUT, forward as DELETE};
