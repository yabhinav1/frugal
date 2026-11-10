import assert from 'node:assert/strict';
import test from 'node:test';
import { Cart } from '../src/cart.js';
import { canCancel, createOrder, transition } from '../src/orders.js';

const newOrder = () => createOrder(new Cart('XX').add({ id: 'a', name: 'A', price: 5 }).toJSON(), 'u1');

test('pending and paid orders can be cancelled', () => {
  const pending = newOrder();
  assert.equal(canCancel(pending), true);
  const paid = transition(newOrder(), 'paid');
  assert.equal(canCancel(paid), true);
  assert.equal(transition(paid, 'cancelled').status, 'cancelled');
});

test('a shipped order cannot be cancelled', () => {
  const order = transition(transition(newOrder(), 'paid'), 'shipped');
  assert.equal(canCancel(order), false);
  assert.throws(() => transition(order, 'cancelled'), /Cannot move order from shipped to cancelled/);
  assert.equal(order.status, 'shipped');
  assert.equal(order.history.length, 3);
});

test('a shipped order can still be delivered', () => {
  const order = transition(transition(newOrder(), 'paid'), 'shipped');
  assert.equal(transition(order, 'delivered').status, 'delivered');
  assert.equal(canCancel(order), false);
});
