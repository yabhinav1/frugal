import assert from 'node:assert/strict';
import test from 'node:test';
import { Cart } from '../src/cart.js';
import { applyDiscount } from '../src/pricing.js';

test('applyDiscount takes a percentage off', () => {
  assert.equal(applyDiscount(200, 10), 180);
  assert.equal(applyDiscount(80, 25), 60);
  assert.equal(applyDiscount(50, 0), 50);
  assert.equal(applyDiscount(50, 100), 0);
});

test('a percent coupon reduces the cart total', () => {
  const cart = new Cart('XX').add({ id: 'a', name: 'A', price: 100 });
  assert.equal(cart.applyCoupon('SAVE10'), true);
  assert.equal(cart.total(), 90);
});
