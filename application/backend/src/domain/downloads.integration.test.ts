import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const enabled = process.env.RUN_INTEGRATION === '1';
const backend = process.env.BUSINESS_BASE_URL ?? 'http://backend:3000';

async function request(path: string, cookie: string | null, options: RequestInit = {}): Promise<{status: number; data: any}> {
  const response = await fetch(new URL(path, backend), {
    ...options,
    headers: {...(cookie ? {cookie} : {}), ...(options.headers as Record<string, string> || {})},
  });
  return {status: response.status, data: response.status === 204 ? null : await response.json()};
}

async function login(name: string, email = `${randomUUID()}@example.test`): Promise<{userId: string; cookie: string; token: string}> {
  const response = await fetch(new URL('/dev/sessions', backend), {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name, email}),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const data = await response.json() as {userId: string};
  return {userId: data.userId, cookie, token: cookie.split('=')[1]!};
}

async function padApi(method: string, params: Record<string, string>): Promise<any> {
  const apiKey = readFileSync(process.env.ETHERPAD_API_KEY_FILE!, 'utf8').trim();
  const response = await fetch(new URL(`/api/1.3.1/${method}`, process.env.ETHERPAD_API_URL), {
    method: 'POST', body: new URLSearchParams({apikey: apiKey, ...params}),
  });
  const payload = await response.json() as {code: number; message: string; data: any};
  assert.equal(payload.code, 0, `${method}: ${payload.message}`);
  return payload.data;
}

async function createDocument(owner: {cookie: string}): Promise<{branchId: string; padId: string}> {
  const created = await request('/documents', owner.cookie, {
    method: 'POST', headers: {'content-type': 'application/json', 'Idempotency-Key': randomUUID()},
    body: JSON.stringify({title: 'Download journal', ownerTimeZone: 'Europe/Paris'}),
  });
  assert.equal(created.status, 201);
  return {branchId: created.data.branchId, padId: created.data.padId};
}

async function createLink(owner: {cookie: string}, branchId: string, maxDownloads: number): Promise<string> {
  const link = await request(`/branches/${branchId}/download-links`, owner.cookie, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({maxDownloads}),
  });
  assert.equal(link.status, 201);
  return new URL(link.data.url).pathname;
}

async function download(path: string): Promise<{status: number; type: string | null; body: Buffer}> {
  const response = await fetch(new URL(path, backend));
  return {status: response.status, type: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer())};
}

test('a link never delivers more than its limit under concurrency', {skip: !enabled}, async () => {
  const owner = await login('Owner');
  const doc = await createDocument(owner);
  await padApi('setText', {padID: doc.padId, text: 'hello world from the pad'});
  for (const [limit, visitors] of [[1, 40], [5, 60]] as const) {
    const path = await createLink(owner, doc.branchId, limit);
    const results = await Promise.all(Array.from({length: visitors}, () => download(path)));
    const delivered = results.filter((item) => item.status === 200);
    assert.equal(delivered.length, limit, `exactly ${limit} downloads must succeed`);
    assert.equal(results.filter((item) => item.status === 410).length, visitors - limit);
    for (const item of delivered) {
      assert.equal(item.type, 'application/pdf');
      assert.ok(item.body.subarray(0, 5).toString() === '%PDF-');
      assert.ok(item.body.includes(Buffer.from('hello world from the pad')));
    }
    const status = await request(`${path}/status`, null);
    assert.deepEqual(status.data, {state: 'EXHAUSTED', remaining: 0});
  }
});

test('the same link gives the document as it is at download time', {skip: !enabled}, async () => {
  const owner = await login('Owner');
  const doc = await createDocument(owner);
  const path = await createLink(owner, doc.branchId, 3);
  await padApi('setText', {padID: doc.padId, text: 'first draft'});
  const first = await download(path);
  await padApi('setText', {padID: doc.padId, text: 'corrected text after the announcement'});
  const second = await download(path);
  assert.ok(first.body.includes(Buffer.from('first draft')));
  assert.ok(second.body.includes(Buffer.from('corrected text after the announcement')));
  assert.ok(!second.body.includes(Buffer.from('first draft')));
  assert.deepEqual((await request(`${path}/status`, null)).data, {state: 'AVAILABLE', remaining: 1});
});

test('unknown links, bad tokens, and non-owners are refused', {skip: !enabled}, async () => {
  const owner = await login('Owner');
  const stranger = await login('Stranger');
  const doc = await createDocument(owner);
  assert.equal((await download(`/d/${randomBytes(32).toString('hex')}`)).status, 404);
  assert.equal((await download('/d/not-a-token')).status, 404);
  const denied = await request(`/branches/${doc.branchId}/download-links`, stranger.cookie, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({maxDownloads: 3}),
  });
  assert.equal(denied.status, 403);
  const invalid = await request(`/branches/${doc.branchId}/download-links`, owner.cookie, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({maxDownloads: 0}),
  });
  assert.equal(invalid.status, 400);
  const listed = await request(`/branches/${doc.branchId}/download-links`, owner.cookie);
  assert.equal(listed.status, 200);
});

test('the daily writing credit is never exceeded, even from several devices at once', {skip: !enabled}, async () => {
  const email = `${randomUUID()}@example.test`;
  const phone = await login('Writer', email);
  const laptop = await login('Writer', email);
  assert.equal(phone.userId, laptop.userId, 'two sessions of the same address are the same writer');
  const doc = await createDocument(phone);
  const key = readFileSync(process.env.INTERNAL_KEY_FILE!, 'utf8').trim();
  const write = async (token: string, cost: number) => (await request('/internal/editor-access', null, {
    method: 'POST', headers: {'content-type': 'application/json', 'x-internal-key': key},
    body: JSON.stringify({padId: doc.padId, sessionToken: token, write: true, cost}),
  })).status;

  const burst = await Promise.all(Array.from({length: 20}, (_value, index) => write(index % 2 ? phone.token : laptop.token, 600)));
  assert.equal(burst.filter((status) => status === 200).length, 16, '16 x 600 = 9600 fits in 10000');
  assert.equal(burst.filter((status) => status === 403).length, 4);
  assert.equal(await write(phone.token, 401), 403, '9600 + 401 would exceed the credit');
  assert.equal(await write(laptop.token, 400), 200, 'exactly the remaining 400');
  assert.equal(await write(phone.token, 1), 403, 'nothing remains');
  assert.equal(await write(phone.token, 0), 200, 'deleting or formatting costs nothing');
});
