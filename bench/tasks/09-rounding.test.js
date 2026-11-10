import assert from 'node:assert/strict';
import test from 'node:test';
import { Cart } from '../src/cart.js';
import { taxFor } from '../src/pricing.js';

test('tax is rounded to the cent', () => {
  assert.equal(taxFor(19.99, 'US'), 1.4);
  assert.equal(taxFor(0.1, 'DE'), 0.02);
  assert.equal(taxFor(10, 'XX'), 0);
});

test('cart totals are whole cents', () => {
  const cart = new Cart('US').add({ id: 'a', name: 'A', price: 19.99 });
  assert.equal(cart.total(), 21.39);
  const three = new Cart('IN').add({ id: 'b', name: 'B', price: 0.1 }, 3);
  assert.equal(three.total(), 0.35);
});

test('the snapshot carries rounded figures too', () => {
  const snap = new Cart('XX').add({ id: 'b', name: 'B', price: 0.1 }, 3).toJSON();
  assert.equal(snap.subtotal, 0.3);
  assert.equal(snap.total, 0.3);
});
