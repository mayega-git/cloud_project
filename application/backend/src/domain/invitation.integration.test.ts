import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {pool} from '../database.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const base = process.env.BUSINESS_BASE_URL ?? 'http://backend:3000';
const internalKey = enabled ? readFileSync(process.env.INTERNAL_KEY_FILE!, 'utf8').trim() : '';

async function request(path: string, cookie: string | null, options: RequestInit = {}) {
  const response = await fetch(new URL(path, base), {
    ...options, headers: {...(cookie ? {cookie} : {}), ...(options.headers || {})},
  });
  const body = response.status === 204 ? null : await response.json();
  return {status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null};
}
function json(body: unknown, headers: Record<string, string> = {}) {
  return {method: 'POST', headers: {'content-type': 'application/json',
    origin: 'http://127.0.0.1:3000', ...headers}, body: JSON.stringify(body)};
}

async function verifiedIdentity(name: string) {
  const email = `${randomUUID()}@example.test`;
  const sent = await request('/api/auth/email-otp/send-verification-otp', null,
    json({email, type: 'sign-in'}));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const mailbox = await request(`/dev/mailbox?email=${encodeURIComponent(email)}`, null,
    {headers: {'x-internal-key': internalKey}});
  assert.equal(mailbox.status, 200);
  const otp = /[0-9]{6}/.exec(mailbox.body.at(-1).text)?.[0];
  assert.ok(otp);
  const signed = await request('/api/auth/sign-in/email-otp', null, json({email, otp, name}));
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.ok(signed.cookie);
  const completed = await request('/auth/complete', signed.cookie, {method: 'POST'});
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.ok(completed.cookie);
  return {email, userId: completed.body.userId as string, cookie: completed.cookie};
}

test('verified email invitation grants only branch access after explicit acceptance',
  {skip: !enabled}, async () => {
    const owner = await verifiedIdentity('Project owner');
    const recipient = await verifiedIdentity('Invited writer');
    const wrong = await verifiedIdentity('Other person');
    const created = await request('/projects', owner.cookie,
      json({title: 'Invited journal', ownerTimeZone: 'Europe/Paris'},
        {'Idempotency-Key': randomUUID()}));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const branchId = created.body.branchId as string;
    const invite = await request(`/branches/${branchId}/invitations`, owner.cookie,
      json({email: recipient.email, access: 'WRITE'}, {'Idempotency-Key': randomUUID()}));
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    assert.equal(invite.body.emailStatus, 'SENT');
    assert.equal((await request(`/branches/${branchId}/versions`, recipient.cookie)).status, 403);
    assert.equal((await request(`/branches/${branchId}/invitations`, recipient.cookie,
      json({email: wrong.email, access: 'READ'}, {'Idempotency-Key': randomUUID()}))).status, 403);
    const mailbox = await request(`/dev/mailbox?email=${encodeURIComponent(recipient.email)}`, null,
      {headers: {'x-internal-key': internalKey}});
    const token = /#invite=([0-9a-f]{64})/.exec(mailbox.body.at(-1).text)?.[1];
    assert.ok(token);
    assert.equal((await request('/invitations/accept', wrong.cookie, json({token}))).status, 403);
    const accepted = await Promise.all([
      request('/invitations/accept', recipient.cookie, json({token})),
      request('/invitations/accept', recipient.cookie, json({token})),
    ]);
    assert.deepEqual(accepted.map((item) => item.status).sort(), [200, 409]);
    assert.equal((await request(`/branches/${branchId}/versions`, recipient.cookie)).status, 200);
    const permission = await pool.query(
      'SELECT access FROM business.permissions WHERE branch_id=$1 AND user_id=$2', [branchId, recipient.userId]);
    assert.equal(permission.rows[0].access, 'WRITE');
    assert.equal((await request('/invitations/accept', recipient.cookie, json({token}))).status, 409);
    const padAccess = async (padId: string, write: boolean) =>
      request('/internal/editor-access', null,
        json({padId, sessionToken: recipient.cookie!.split('=')[1], write},
          {'x-internal-key': internalKey}));
    assert.equal((await padAccess(created.body.padId, true)).status, 200);
    const readOnly = await request(
      `/branches/${branchId}/collaborators/${recipient.userId}`, owner.cookie,
      {method: 'PUT', headers: {'content-type': 'application/json'},
        body: JSON.stringify({access: 'READ'})});
    assert.equal(readOnly.status, 204);
    assert.equal((await padAccess(created.body.padId, false)).status, 200);
    assert.equal((await padAccess(created.body.padId, true)).status, 403);
    const close = await request(`/branches/${branchId}/closures`, owner.cookie,
      {method: 'POST', headers: {'Idempotency-Key': randomUUID()}});
    assert.equal(close.status, 202);
    let versions: any[] = [];
    for (let attempt = 0; attempt < 25; attempt++) {
      const response = await request(`/branches/${branchId}/versions`, recipient.cookie);
      versions = response.body;
      if (versions.length === 2 && versions[1].state === 'OPEN') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(versions.length, 2);
    assert.equal((await padAccess(versions[0].padId, true)).status, 403);
    assert.equal((await padAccess(versions[1].padId, true)).status, 403);
    const restored = await request(`/versions/${versions[0].id}/restorations`, owner.cookie,
      json({revision: versions[0].finalRevision}, {'Idempotency-Key': randomUUID()}));
    assert.equal(restored.status, 202);
    let branches: any[] = [];
    for (let attempt = 0; attempt < 25; attempt++) {
      const response = await request(`/projects/${created.body.id}/branches`, owner.cookie);
      branches = response.body;
      if (branches.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(branches.length, 2);
    assert.equal((await request(`/projects/${created.body.id}/branches`, recipient.cookie)).body.length, 1);
    assert.equal((await request(`/branches/${branches[1].id}/versions`, recipient.cookie)).status, 403);
    assert.equal((await request(
      `/branches/${branchId}/collaborators/${recipient.userId}`, owner.cookie,
      {method: 'DELETE'})).status, 204);
    assert.equal((await padAccess(versions[1].padId, false)).status, 403);
  });

test('unknown recipients, resend, expiry, revocation, and local mail retry',
  {skip: !enabled}, async () => {
    const owner = await verifiedIdentity('Second owner');
    const created = await request('/projects', owner.cookie,
      json({title: 'Second project', ownerTimeZone: 'Africa/Abidjan'},
        {'Idempotency-Key': randomUUID()}));
    assert.equal(created.status, 201);
    const branchId = created.body.branchId as string;
    const unknownEmail = `${randomUUID()}@example.test`;
    const first = await request(`/branches/${branchId}/invitations`, owner.cookie,
      json({email: unknownEmail, access: 'READ'}, {'Idempotency-Key': randomUUID()}));
    assert.equal(first.status, 201);
    assert.equal(first.body.emailStatus, 'SENT');
    assert.equal((await pool.query('SELECT 1 FROM business.users WHERE email=$1', [unknownEmail])).rowCount, 0);
    const firstMail = await request(`/dev/mailbox?email=${encodeURIComponent(unknownEmail)}`, null,
      {headers: {'x-internal-key': internalKey}});
    const oldToken = /#invite=([0-9a-f]{64})/.exec(firstMail.body.at(-1).text)?.[1];
    assert.ok(oldToken);
    const duplicate = await request(`/branches/${branchId}/invitations`, owner.cookie,
      json({email: unknownEmail, access: 'READ'}, {'Idempotency-Key': randomUUID()}));
    assert.equal(duplicate.status, 409);
    const resend = await request(`/invitations/${first.body.id}/resend`, owner.cookie, json({access: 'WRITE'}));
    assert.equal(resend.status, 200);
    const laterMail = await request(`/dev/mailbox?email=${encodeURIComponent(unknownEmail)}`, null,
      {headers: {'x-internal-key': internalKey}});
    const newToken = /#invite=([0-9a-f]{64})/.exec(laterMail.body.at(-1).text)?.[1];
    assert.ok(newToken);
    assert.notEqual(newToken, oldToken);
    assert.equal((await request('/invitations/preview', null, json({token: oldToken}))).status, 404);
    assert.equal((await request('/invitations/preview', null, json({token: newToken}))).body.access, 'WRITE');
    assert.equal((await request(`/invitations/${first.body.id}`, owner.cookie, {method: 'DELETE'})).status, 204);
    assert.equal((await request('/invitations/preview', null, json({token: newToken}))).body.state, 'REVOKED');

    const expiringEmail = `${randomUUID()}@example.test`;
    const expiring = await request(`/branches/${branchId}/invitations`, owner.cookie,
      json({email: expiringEmail, access: 'READ'}, {'Idempotency-Key': randomUUID()}));
    const expiringMail = await request(`/dev/mailbox?email=${encodeURIComponent(expiringEmail)}`, null,
      {headers: {'x-internal-key': internalKey}});
    const expiredToken = /#invite=([0-9a-f]{64})/.exec(expiringMail.body.at(-1).text)?.[1];
    assert.ok(expiredToken);
    await pool.query("UPDATE business.invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expiring.body.id]);
    const recipient = await verifiedIdentity('Late recipient');
    assert.equal((await request('/invitations/accept', recipient.cookie, json({token: expiredToken}))).status, 410);

    const failingEmail = `${randomUUID()}@fail.test`;
    const failed = await request(`/branches/${branchId}/invitations`, owner.cookie,
      json({email: failingEmail, access: 'READ'}, {'Idempotency-Key': randomUUID()}));
    assert.equal(failed.status, 201);
    assert.equal(failed.body.emailStatus, 'FAILED');
    const retried = await request(`/invitations/${failed.body.id}/resend`, owner.cookie, json({}));
    assert.equal(retried.status, 200);
    assert.equal(retried.body.emailStatus, 'SENT');
  });
