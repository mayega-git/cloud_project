import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {pool} from '../database.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const backend = process.env.BUSINESS_BASE_URL ?? 'http://backend:3000';

async function request(path: string, cookie: string | null, options: RequestInit = {}): Promise<{status: number; data: any}> {
  const response = await fetch(new URL(path, backend), {
    ...options,
    headers: {...(cookie ? {cookie} : {}), ...(options.headers as Record<string, string> || {})},
  });
  return {status: response.status, data: response.status === 204 ? null : await response.json()};
}

async function login(name: string): Promise<{userId: string; cookie: string; token: string}> {
  const response = await fetch(new URL('/dev/sessions', backend), {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({name, email: `${randomUUID()}@example.test`}),
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

async function waitFor(path: string, cookie: string, state: string): Promise<any> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await request(path, cookie);
    assert.equal(result.status, 200);
    if (result.data.state === state) return result.data;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`${path} did not reach ${state}`);
}

test('real Etherpad preserves rich content, branch access, and one successor', {skip: !enabled}, async () => {
  const owner = await login('Owner');
  const writer = await login('Writer');
  const createKey = randomUUID();
  const created = await request('/documents', owner.cookie, {
    method: 'POST', headers: {'content-type': 'application/json', 'Idempotency-Key': createKey},
    body: JSON.stringify({title: 'Integration journal', ownerTimeZone: 'Europe/Paris'}),
  });
  assert.equal(created.status, 201);
  const doc = created.data;
  const repeated = await request('/documents', owner.cookie, {
    method: 'POST', headers: {'content-type': 'application/json', 'Idempotency-Key': createKey},
    body: JSON.stringify({title: 'Integration journal', ownerTimeZone: 'Europe/Paris'}),
  });
  assert.equal(repeated.data.id, doc.id);

  assert.equal((await request(`/branches/${doc.branchId}/versions`, writer.cookie)).status, 403);
  assert.equal((await request(`/branches/${doc.branchId}/permissions/${writer.userId}`, owner.cookie, {
    method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({access: 'WRITE'}),
  })).status, 204);
  assert.equal((await request(`/branches/${doc.branchId}/versions`, writer.cookie)).status, 200);

  await padApi('setHTML', {padID: doc.padId, html: '<p><strong>Bold</strong> and <em>italic</em></p>'});
  const sourceHtml = (await padApi('getHTML', {padID: doc.padId})).html;
  const closeKey = randomUUID();
  const closePath = `/branches/${doc.branchId}/closures`;
  const closeOptions = {method: 'POST', headers: {'Idempotency-Key': closeKey}};
  const [first, second] = await Promise.all([
    request(closePath, owner.cookie, closeOptions),
    request(closePath, owner.cookie, {method: 'POST', headers: {'Idempotency-Key': randomUUID()}}),
  ]);
  assert.equal(first.status, 202);
  assert.equal(first.data.operationId, second.data.operationId);
  const finished = await waitFor(`/closures/${first.data.operationId}`, owner.cookie, 'COMPLETED');
  const repeatedClosure = await request(closePath, owner.cookie, closeOptions);
  assert.equal(repeatedClosure.data.operationId, first.data.operationId);
  const versions = (await request(`/branches/${doc.branchId}/versions`, owner.cookie)).data;
  assert.deepEqual(versions.map((item: any) => item.state), ['FROZEN', 'OPEN']);
  assert.equal(versions[1].id, finished.successorVersionId);
  const frozenWrite = await request('/internal/editor-access', null, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-internal-key': readFileSync(process.env.INTERNAL_KEY_FILE!, 'utf8').trim()},
    body: JSON.stringify({padId: versions[0].padId, sessionToken: owner.token, write: true}),
  });
  assert.equal(frozenWrite.status, 409);
  assert.equal((await padApi('getHTML', {padID: versions[1].padId})).html, sourceHtml);
  assert.equal((await request(`/branches/${doc.branchId}/versions`, writer.cookie)).status, 200);

  const restoration = await request(`/versions/${versions[0].id}/restorations`, owner.cookie, {
    method: 'POST', headers: {'content-type': 'application/json', 'Idempotency-Key': randomUUID()},
    body: JSON.stringify({revision: versions[0].finalRevision}),
  });
  assert.equal(restoration.status, 202);
  const restored = await waitFor(`/restorations/${restoration.data.operationId}`, owner.cookie, 'COMPLETED');
  const restoredVersions = (await request(`/branches/${restored.destinationBranchId}/versions`, owner.cookie)).data;
  assert.equal((await padApi('getHTML', {padID: restoredVersions[0].padId})).html, sourceHtml);
  assert.notEqual(restoredVersions[0].padId, versions[0].padId);
  await padApi('setText', {padID: restoredVersions[0].padId, text: 'Independent branch'});
  assert.equal((await padApi('getHTML', {padID: versions[0].padId})).html, sourceHtml);
  assert.equal((await request(`/branches/${restored.destinationBranchId}/versions`, writer.cookie)).status, 403);

  const count = await pool.query(
    "SELECT count(*)::int AS total FROM business.versions WHERE branch_id=$1 AND state IN ('OPEN','CLOSING')", [doc.branchId]);
  assert.equal(count.rows[0].total, 1);
});

test('overdue daily rollover creates one successor and skips missed empty days', {skip: !enabled}, async () => {
  const owner = await login('Daily owner');
  const created = await request('/documents', owner.cookie, {
    method: 'POST', headers: {'content-type': 'application/json', 'Idempotency-Key': randomUUID()},
    body: JSON.stringify({title: 'Daily journal', ownerTimeZone: 'Europe/Paris'}),
  });
  assert.equal(created.status, 201);
  const doc = created.data;
  const overdue = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await pool.query('UPDATE business.documents SET next_daily_at=$2 WHERE id=$1', [doc.id, overdue]);
  for (let attempt = 0; attempt < 25; attempt++) {
    const versions = (await request(`/branches/${doc.branchId}/versions`, owner.cookie)).data;
    if (versions.length === 2 && versions[1].state === 'OPEN') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const versions = (await request(`/branches/${doc.branchId}/versions`, owner.cookie)).data;
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map((item: any) => item.state), ['FROZEN', 'OPEN']);
  const schedule = await pool.query('SELECT next_daily_at>clock_timestamp() AS future FROM business.documents WHERE id=$1', [doc.id]);
  assert.equal(schedule.rows[0].future, true);
  const daily = await pool.query("SELECT count(*)::int AS total FROM business.closures WHERE branch_id=$1 AND cause='DAILY'", [doc.branchId]);
  assert.equal(daily.rows[0].total, 1);
  await pool.query('UPDATE business.documents SET next_daily_at=$2 WHERE id=$1', [doc.id, overdue]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const retried = (await request(`/branches/${doc.branchId}/versions`, owner.cookie)).data;
  assert.equal(retried.length, 2);
  const dailyAfterRetry = await pool.query("SELECT count(*)::int AS total FROM business.closures WHERE branch_id=$1 AND cause='DAILY'", [doc.branchId]);
  assert.equal(dailyAfterRetry.rows[0].total, 1);
});
