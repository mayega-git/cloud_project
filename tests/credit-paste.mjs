// C4: the daily writing credit (10,000 inserted characters per writer and per day) is
// enforced by the server. A writer pastes 9,000 characters (accepted), then 2,000 more
// (refused, because 11,000 > 10,000). The text kept by the server is read through the
// API and must still be the first 9,000 characters.
//
//   npm install playwright-core
//   BASE_URL=http://<host> node tests/credit-paste.mjs
//
// Browser: set CHROME_PATH to a Chrome or Chromium binary, otherwise Playwright uses its
// own Chromium (npx playwright-core install chromium).

import {chromium} from 'playwright-core';

const base = (process.env.BASE_URL ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('BASE_URL is required, for example http://127.0.0.1:3000');
  process.exit(2);
}

let failed = false;
function check(label, ok) {
  console.log(`${ok ? 'ok    ' : 'FAILED'} ${label}`);
  if (!ok) failed = true;
}

const padBody = (page) => page.frameLocator('iframe[name="ace_outer"]')
  .frameLocator('iframe[name="ace_inner"]').locator('#innerdocbody');

const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, headless: true});
const context = await browser.newContext({viewport: {width: 1000, height: 700}});
const api = await context.newPage();
await api.goto(`${base}/health`);

const email = `writer-${Date.now()}@example.test`;
const created = await api.evaluate(async ({email}) => {
  const session = await fetch('/dev/sessions', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({name: 'Writer', email}),
  });
  if (session.status !== 201) throw new Error(`/dev/sessions answered ${session.status}`);
  const document = await fetch('/documents', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'Idempotency-Key': `credit-${Date.now()}-document`},
    body: JSON.stringify({title: 'Credit test', ownerTimeZone: 'Europe/Paris'}),
  });
  return document.json();
}, {email});

const pad = await context.newPage();
await pad.goto(created.editorUrl);
await padBody(pad).waitFor({timeout: 60000});
await padBody(pad).click();

await pad.keyboard.insertText('a'.repeat(9000));
await pad.waitForTimeout(4000);
await pad.keyboard.insertText('b'.repeat(2000));
await pad.waitForTimeout(6000);

const stored = await api.evaluate(async ({versionId}) => {
  const response = await fetch(`/versions/${versionId}/content`);
  return (await response.json()).text;
}, {versionId: created.versionId});
const kept = stored.replace(/\s/g, '');

console.log(`characters kept by the server: ${kept.length}`);
check('the first paste of 9,000 characters is kept', kept.startsWith('a'.repeat(9000)));
check('nothing of the refused paste (2,000 characters) is stored', !kept.includes('b'));
check('the stored text is exactly 9,000 characters', kept.length === 9000);

await browser.close();
process.exit(failed ? 1 : 0);
