// Token savers that work without any model call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isolateHome, tempRepo } from './helpers.ts';

isolateHome();
const { condenseOutput } = await import('../src/tools.ts');
const { mentionedFiles, supersedeCommandOutputs } = await import('../src/context.ts');
type Message = import('../src/types.ts').Message;

const NODE_TEST_FAIL = `
> shopkit@1.4.0 test
> node --test

✔ cart subtotal and count (1.2ms)
✔ coupons parse (0.3ms)
✖ applyDiscount takes a percentage off (0.9ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  -19800 !== 180

      at TestContext.<anonymous> (file:///repo/test/01.test.js:7:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1047:25)
✔ formatPrice (0.2ms)
ℹ tests 4
ℹ suites 0
ℹ pass 3
ℹ fail 1
ℹ duration_ms 91.5

✖ failing tests:

test at test/01.test.js:6:1
✖ applyDiscount takes a percentage off (0.9ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  -19800 !== 180

      at TestContext.<anonymous> (file:///repo/test/01.test.js:7:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1047:25)
`;

test('failing test output keeps the failure and drops the noise', () => {
  const out = condenseOutput(NODE_TEST_FAIL, false);
  assert.match(out, /applyDiscount takes a percentage off/);
  assert.match(out, /-19800 !== 180/);
  assert.match(out, /test\/01\.test\.js:7:10/, 'the frame in project code is kept');
  assert.match(out, /ℹ fail 1/);
  assert.doesNotMatch(out, /cart subtotal|formatPrice|node:internal|node:async_hooks|shopkit@/);
  assert.equal(out.split('-19800 !== 180').length - 1, 1, 'the duplicated failure report appears once');
  assert.ok(out.length < NODE_TEST_FAIL.length / 2, `${out.length} of ${NODE_TEST_FAIL.length} chars`);
});

test('output that is not from a test runner is left intact', () => {
  const text = 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number.\nFound 1 error.';
  assert.equal(condenseOutput(text, false), text);
});

test('a long successful run is reduced to its tail', () => {
  const text = `${'compiling module\n'.repeat(400)}Build finished: 400 modules, 0 errors`;
  const out = condenseOutput(text, true);
  assert.ok(out.length < 1300);
  assert.match(out, /Build finished: 400 modules, 0 errors$/);
});

test('a re-run replaces the earlier output of the same command, and only that command', () => {
  const call = (id: string, cmd: string): Message => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'sh', arguments: JSON.stringify({ cmd }) } }] });
  const long = `exit 1\n${'✖ some failing test detail line\n'.repeat(30)}`;
  const messages: Message[] = [
    call('a', 'npm test'),
    { role: 'tool', tool_call_id: 'a', content: long },
    call('b', 'npm run lint'),
    { role: 'tool', tool_call_id: 'b', content: long },
    call('c', 'npm test'),
    { role: 'tool', tool_call_id: 'c', content: 'exit 0\nℹ pass 4' },
  ];
  const saved = supersedeCommandOutputs(messages, 'npm test', 'c');
  assert.ok(saved > 100);
  assert.match(messages[1]!.content!, /^\[exit 1; output replaced by the later run/);
  assert.equal(messages[3]!.content, long, 'a different command is untouched');
  assert.equal(messages[5]!.content, 'exit 0\nℹ pass 4', 'the latest run is untouched');
});

test('files named in the task are found, along with what they import', () => {
  const root = tempRepo({
    'test/cart.test.js': "import { Cart } from '../src/cart.js';\nimport assert from 'node:assert';\n",
    'src/cart.js': "import { tax } from './pricing.js';\nexport class Cart {}\n",
    'src/pricing.js': 'export const tax = 1;\n',
    'src/unrelated.js': 'export {};\n',
    '.env': 'SECRET=1\n',
  });
  const found = mentionedFiles(root, 'Totals are wrong, see test/cart.test.js. Fix it (v1.2.3 broke it) and run npm test.');
  assert.deepEqual(found, ['test/cart.test.js', 'src/cart.js'], 'the test, plus one level of its imports');
  assert.deepEqual(mentionedFiles(root, 'no files mentioned here, just e.g. words'), []);
  assert.deepEqual(mentionedFiles(root, 'look at ../../outside.txt and C:/Windows/win.ini'), [], 'nothing outside the repo');
});
