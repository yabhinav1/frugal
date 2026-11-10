import assert from 'node:assert/strict';
import test from 'node:test';
import { createUser, validateEmail } from '../src/users.js';

test('ordinary addresses are accepted', () => {
  assert.equal(validateEmail('ana@example.com'), true);
  assert.equal(validateEmail('first.last@example.org'), true);
});

test('plus addressing, dashes and subdomains are accepted', () => {
  assert.equal(validateEmail('ana+shop@example.com'), true);
  assert.equal(validateEmail('ana-maria@mail.example.co.uk'), true);
  assert.equal(validateEmail('a_b@sub.domain.example.io'), true);
});

test('malformed addresses are rejected', () => {
  for (const bad of ['ana@example', '@example.com', 'ana@', 'ana example@x.com', 'ana@@example.com', 'ana@.com', 'ana@example..com', '.ana@example.com', 'ana@example.c']) {
    assert.equal(validateEmail(bad), false, bad);
  }
});

test('createUser accepts a plus address', () => {
  const user = createUser({ name: 'ana li', email: 'Ana+Shop@Example.com', password: 'Correct4Horse' });
  assert.equal(user.email, 'ana+shop@example.com');
  assert.equal(user.name, 'Ana Li');
});
