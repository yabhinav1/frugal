import assert from 'node:assert/strict';
import test from 'node:test';
import { slugify } from '../src/utils.js';

test('words are joined by single dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('Hello,   World!'), 'hello-world');
});

test('no leading or trailing dashes', () => {
  assert.equal(slugify('  Blue Pen (new) '), 'blue-pen-new');
  assert.equal(slugify('--already--slugged--'), 'already-slugged');
});

test('accented letters are reduced to plain ones', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
  assert.equal(slugify('Señor Niño'), 'senor-nino');
});

test('digits are kept and empty input gives an empty slug', () => {
  assert.equal(slugify('A5 Notebook 2026'), 'a5-notebook-2026');
  assert.equal(slugify('!!!'), '');
});
