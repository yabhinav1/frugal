import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.js';

const store = new Store(Array.from({ length: 25 }, (_, i) => ({ id: `p${i + 1}`, n: i + 1 })));

test('page 1 starts at the first item', () => {
  const page = store.paginate(1, 10);
  assert.deepEqual(page.items.map((p) => p.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(page.pages, 3);
  assert.equal(page.total, 25);
});

test('the last page holds the remainder', () => {
  assert.deepEqual(store.paginate(3, 10).items.map((p) => p.n), [21, 22, 23, 24, 25]);
});

test('a page past the end is empty', () => {
  assert.deepEqual(store.paginate(4, 10).items, []);
});
