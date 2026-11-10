import assert from 'node:assert/strict';
import test from 'node:test';
import { Inventory } from '../src/inventory.js';

test('lowStock lists SKUs at or below the threshold, sorted', () => {
  const inv = new Inventory({ pen: 2, book: 10, ink: 0, cap: 5 });
  assert.deepEqual(inv.lowStock(2), ['ink', 'pen']);
  assert.deepEqual(inv.lowStock(5), ['cap', 'ink', 'pen']);
});

test('lowStock counts reserved units as unavailable', () => {
  const inv = new Inventory({ pen: 6, book: 10 });
  inv.reserve('pen', 4);
  assert.deepEqual(inv.lowStock(3), ['pen']);
});

test('lowStock defaults to a threshold of 5 and rejects negatives', () => {
  const inv = new Inventory({ pen: 5, book: 6 });
  assert.deepEqual(inv.lowStock(), ['pen']);
  assert.throws(() => inv.lowStock(-1), RangeError);
});
