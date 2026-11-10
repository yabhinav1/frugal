import assert from 'node:assert/strict';
import test from 'node:test';
import { addBusinessDays, estimateDelivery, formatDate, parseDate } from '../src/dates.js';

const plus = (date, n) => formatDate(addBusinessDays(parseDate(date), n));

test('weekdays advance one at a time', () => {
  assert.equal(plus('2026-11-09', 1), '2026-11-10'); // Mon -> Tue
  assert.equal(plus('2026-11-09', 4), '2026-11-13'); // Mon -> Fri
});

test('Saturday and Sunday are both skipped', () => {
  assert.equal(plus('2026-11-13', 1), '2026-11-16'); // Fri -> Mon
  assert.equal(plus('2026-11-12', 2), '2026-11-16'); // Thu -> Mon
  assert.equal(plus('2026-11-13', 6), '2026-11-23'); // Fri -> Mon the week after next
});

test('starting on a weekend lands on a weekday', () => {
  assert.equal(plus('2026-11-14', 1), '2026-11-16'); // Sat -> Mon
  assert.equal(plus('2026-11-15', 0), '2026-11-15'); // zero days: unchanged
});

test('standard delivery is five business days', () => {
  assert.equal(formatDate(estimateDelivery(parseDate('2026-11-11'))), '2026-11-18'); // Wed -> next Wed
});
