// C1: a limited download link never delivers more PDFs than its limit, however many
// visitors click at the same time. Node 20 or later, no dependency.
//
//   BASE_URL=http://<host> node tests/c1-download-limit.mjs
//
// Each case is [limit, total requests, requests in flight]. The script exits with
// status 1 if a link delivers more PDFs than its limit, if the delivered and remaining
// counts do not add up to the limit, or if fewer PDFs than the limit are delivered
// although visitors were still asking.

const base = (process.env.BASE_URL ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('BASE_URL is required, for example http://127.0.0.1:3000');
  process.exit(2);
}

const cases = [[1, 200, 100], [500, 2000, 250]];
let failed = false;

function check(label, ok) {
  console.log(`${ok ? 'ok    ' : 'FAILED'} ${label}`);
  if (!ok) failed = true;
}

async function login(name) {
  const response = await fetch(`${base}/dev/sessions`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({name, email: `${name.toLowerCase()}-${Date.now()}@example.test`}),
  });
  if (response.status !== 201) throw new Error(`/dev/sessions answered ${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
}

async function call(path, cookie, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {cookie, ...(options.headers ?? {})},
  });
  return {status: response.status, data: await response.json()};
}

async function pool(total, width, task) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({length: width}, async () => {
    while (next < total) {
      const index = next++;
      results[index] = await task(index);
    }
  }));
  return results;
}

async function visit(path) {
  try {
    const response = await fetch(`${base}${path}`, {signal: AbortSignal.timeout(30000)});
    const body = Buffer.from(await response.arrayBuffer());
    return {status: response.status, pdf: body.subarray(0, 5).toString() === '%PDF-'};
  } catch (error) {
    return {status: `error:${error.cause?.code ?? error.name}`, pdf: false};
  }
}

const cookie = await login('Owner');
const created = await call('/documents', cookie, {
  method: 'POST',
  headers: {'content-type': 'application/json', 'Idempotency-Key': `c1-${Date.now()}-document`},
  body: JSON.stringify({title: 'C1 test', ownerTimeZone: 'Europe/Paris'}),
});
if (created.status !== 201) throw new Error(`/documents answered ${created.status}`);
const branchId = created.data.branchId;

for (const [limit, total, width] of cases) {
  const link = await call(`/branches/${branchId}/download-links`, cookie, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({maxDownloads: limit}),
  });
  if (link.status !== 201) throw new Error(`link creation answered ${link.status}`);
  // Only the path matters: the host inside "url" depends on how the backend is configured.
  const path = new URL(link.data.url).pathname;

  const started = Date.now();
  const results = await pool(total, width, () => visit(path));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const counts = {};
  for (const item of results) counts[item.status] = (counts[item.status] ?? 0) + 1;
  const delivered = results.filter((item) => item.status === 200 && item.pdf).length;
  const status = await (await fetch(`${base}${path}/status`)).json();

  console.log(`\nlimit ${limit}: ${total} requests, ${width} in flight, ${seconds} s`);
  console.log(`statuses: ${JSON.stringify(counts)}`);
  console.log(`status route: ${JSON.stringify(status)}`);
  check(`limit ${limit}: no more than ${limit} PDFs delivered (delivered ${delivered})`, delivered <= limit);
  check(`limit ${limit}: delivered + remaining = ${limit} (${delivered} + ${status.remaining})`,
    delivered + status.remaining === limit);
  check(`limit ${limit}: exactly ${limit} PDFs delivered`, delivered === limit);
}

process.exit(failed ? 1 : 0);
