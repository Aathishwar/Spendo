/**
 * Spendo - calendar arithmetic that no timezone can move
 *
 * `yesterdayISO` used to parse YYYY-MM-DD as UTC midnight and read it back in local
 * time, so west of Greenwich "yesterday" was two days ago. Run this file under
 * TZ=America/Los_Angeles as well as the machine's own zone; it must pass in both.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { shiftDay, yesterdayISO } from '../../js/format.js';

test('yesterday is one calendar day back, across month, year and leap boundaries', () => {
  assert.equal(yesterdayISO('2026-10-03'), '2026-10-02');
  assert.equal(yesterdayISO('2026-10-01'), '2026-09-30');
  assert.equal(yesterdayISO('2026-01-01'), '2025-12-31');
  assert.equal(yesterdayISO('2028-03-01'), '2028-02-29');
  assert.equal(yesterdayISO('2027-03-01'), '2027-02-28');
});

test('shiftDay moves forwards as well as back', () => {
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2026-10-03', 0), '2026-10-03');
  assert.equal(shiftDay('2026-10-03', -30), '2026-09-03');
});
