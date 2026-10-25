import assert from 'node:assert/strict';
import test from 'node:test';
import {nextLocalMidnight} from './calendar.js';

test("next midnight follows the owner's IANA calendar across spring DST", () => {
  assert.equal(nextLocalMidnight('Europe/Paris', new Date('2026-03-28T12:00:00Z')).toISOString(),
    '2026-03-28T23:00:00.000Z');
  assert.equal(nextLocalMidnight('Europe/Paris', new Date('2026-03-29T12:00:00Z')).toISOString(),
    '2026-03-29T22:00:00.000Z');
});

test("next midnight follows the owner's IANA calendar across autumn DST", () => {
  assert.equal(nextLocalMidnight('Europe/Paris', new Date('2026-10-24T12:00:00Z')).toISOString(),
    '2026-10-24T22:00:00.000Z');
  assert.equal(nextLocalMidnight('Europe/Paris', new Date('2026-10-25T12:00:00Z')).toISOString(),
    '2026-10-25T23:00:00.000Z');
});

test('midnight for Africa/Abidjan stays at 00:00 UTC', () => {
  assert.equal(nextLocalMidnight('Africa/Abidjan', new Date('2026-10-25T12:00:00Z')).toISOString(),
    '2026-10-26T00:00:00.000Z');
});
