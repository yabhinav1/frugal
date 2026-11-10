import assert from 'node:assert/strict';
import test from 'node:test';
import { Cart } from '../src/cart.js';
import { Inventory } from '../src/inventory.js';

const pen = { id: 'pen', name: 'Pen', price: 2 };

test('a cart without an inventory behaves as before', () => {
  const cart = new Cart('XX').add(pen, 50);
  assert.equal(cart.count, 50);
});

test('adding reserves stock, and too many is refused', () => {
  const inv = new Inventory({ pen: 3 });
  const cart = new Cart('XX', inv);
  cart.add(pen, 2);
  assert.equal(inv.available('pen'), 1);
  assert.throws(() => cart.add(pen, 2), RangeError);
  assert.equal(cart.count, 2, 'the failed add left the cart unchanged');
  assert.equal(inv.available('pen'), 1);
});

test('removing a line releases its stock', () => {
  const inv = new Inventory({ pen: 3 });
  const cart = new Cart('XX', inv).add(pen, 3);
  assert.equal(inv.available('pen'), 0);
  assert.equal(cart.remove('pen'), true);
  assert.equal(inv.available('pen'), 3);
  assert.equal(cart.remove('pen'), false);
});

test('setQty adjusts the reservation both ways', () => {
  const inv = new Inventory({ pen: 5 });
  const cart = new Cart('XX', inv).add(pen, 2);
  cart.setQty('pen', 4);
  assert.equal(inv.available('pen'), 1);
  cart.setQty('pen', 1);
  assert.equal(inv.available('pen'), 4);
  assert.throws(() => cart.setQty('pen', 9), RangeError);
  assert.equal(cart.count, 1);
  cart.setQty('pen', 0);
  assert.equal(inv.available('pen'), 5);
});
