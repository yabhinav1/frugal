import assert from 'node:assert/strict';
import test from 'node:test';
import { Cart } from '../src/cart.js';
import { Inventory } from '../src/inventory.js';
import { createOrder, transition } from '../src/orders.js';
import { formatPrice, parseCoupon } from '../src/pricing.js';
import { Store } from '../src/store.js';
import { chunk, groupBy } from '../src/utils.js';

const pen = { id: 'pen', name: 'Pen', price: 2 };
const book = { id: 'book', name: 'Book', price: 10 };

test('cart subtotal and count', () => {
  const cart = new Cart('XX').add(pen, 3).add(book);
  assert.equal(cart.subtotal(), 16);
  assert.equal(cart.count, 4);
});

test('coupons parse', () => {
  assert.deepEqual(parseCoupon('save15'), { type: 'percent', value: 15 });
  assert.deepEqual(parseCoupon('FLAT5'), { type: 'flat', value: 5 });
  assert.equal(parseCoupon('BOGUS'), null);
});

test('formatPrice', () => {
  assert.equal(formatPrice(3.5), '$3.50');
  assert.equal(formatPrice(1200, 'JPY'), '¥1200');
});

test('inventory reservations', () => {
  const inv = new Inventory({ pen: 5 });
  inv.reserve('pen', 2);
  assert.equal(inv.available('pen'), 3);
  assert.throws(() => inv.reserve('pen', 4), RangeError);
});

test('order lifecycle', () => {
  const order = createOrder(new Cart('XX').add(book).toJSON(), 'u1');
  transition(order, 'paid');
  transition(order, 'shipped');
  assert.equal(order.status, 'shipped');
  assert.equal(order.history.length, 3);
});

test('store filter and sort', () => {
  const store = new Store([book, pen]);
  assert.deepEqual(store.sortBy('price').items.map((p) => p.id), ['pen', 'book']);
  assert.equal(store.filter((p) => p.price > 5).size, 1);
});

test('utils', () => {
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
  assert.deepEqual(groupBy([1, 2, 3], (n) => (n % 2 ? 'odd' : 'even')), { odd: [1, 3], even: [2] });
});
