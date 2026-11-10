// Model routing, tested with the network replaced by a recorder: what leaves the process, and when.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeFrontend, isolateHome, tempRepo } from './helpers.ts';

isolateHome();
process.env.GROQ_API_KEY = 'test-key'; // pretend one cloud provider is configured
const { Router, emptyStats, readStream } = await import('../src/gateway/router.ts');
const { Budget, BudgetExceededError } = await import('../src/budget.ts');
const { resolvePolicy } = await import('../src/policy.ts');
const { loadConfig } = await import('../src/config.ts');
const { toolCallsOf } = await import('../src/agent.ts');

interface Sent {
  url: string;
  vk: string | null;
  body: { model: string; fallbacks?: string[]; messages: unknown[] };
}

/** Replace fetch. `respond` decides what each request gets back. */
function fakeNetwork(respond: (sent: Sent, n: number) => { status: number; json: unknown } | 'down') {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const record: Sent = { url: String(input), vk: new Headers(init?.headers).get('x-bf-vk'), body: JSON.parse(String(init?.body)) };
    sent.push(record);
    const r = respond(record, sent.length);
    if (r === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as typeof fetch;
  return sent;
}

const reply = (provider: string, model: string, extra: object = {}) => ({
  status: 200,
  json: {
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
    model,
    extra_fields: { provider, routing_info: { provider, model, ...extra } },
  },
});

function setup(opts: { confidential?: boolean; limitUsd?: number } = {}) {
  const cfg = loadConfig();
  cfg.user = `u${Math.random()}`;
  cfg.budget = { limitUsd: opts.limitUsd ?? 1, period: 'day' };
  const policy = resolvePolicy(tempRepo(opts.confidential ? { '.frugal/policy.json': '{"confidential": true}' } : {}));
  const fe = new FakeFrontend();
  const stats = emptyStats();
  const router = new Router(cfg, policy, new Budget(cfg), fe, stats);
  return { cfg, router, fe, stats };
}

const msgs = [{ role: 'user' as const, content: 'SECRET SOURCE CODE' }];

test('normal repo: cloud key, cheap model first, local model as the last fallback', async () => {
  const { cfg, router } = setup();
  const sent = fakeNetwork(() => reply('groq', 'openai/gpt-oss-20b'));
  const out = await router.complete(msgs, [], 'fast');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.vk, cfg.virtualKeys.cloud);
  // Only Groq has a key in this test, so models from other providers are skipped.
  assert.equal(sent[0]!.body.model, cfg.models.fast.find((m) => m.startsWith('groq/')));
  assert.equal(sent[0]!.body.fallbacks!.at(-1), cfg.models.local);
  assert.equal(out.model, 'groq/openai/gpt-oss-20b');
});

test('confidential repo: only the local-only key and the local model ever leave the process', async () => {
  const { cfg, router } = setup({ confidential: true });
  const sent = fakeNetwork(() => reply('ollama', 'frugal-local'));
  for (const tier of ['fast', 'strong', 'local'] as const) await router.complete(msgs, [], tier);
  assert.equal(sent.length, 3);
  for (const s of sent) {
    assert.equal(s.vk, cfg.virtualKeys.local, 'the key that can reach cloud providers is never sent');
    assert.equal(s.body.model, cfg.models.local);
    assert.deepEqual(s.body.fallbacks, []);
    assert.match(s.url, /^http:\/\/127\.0\.0\.1/);
  }
});

test('confidential repo: an answer from a cloud model is discarded, not returned', async () => {
  const { router } = setup({ confidential: true });
  fakeNetwork(() => reply('groq', 'llama-3.3-70b-versatile'));
  await assert.rejects(router.complete(msgs, [], 'fast'), /Policy violation/);
});

test('confidential repo: a remote gateway is bypassed, code goes to local Ollama only', async () => {
  const { cfg, router } = setup({ confidential: true });
  cfg.gatewayUrl = 'https://gateway.example.com';
  const sent = fakeNetwork(() => reply('ollama', 'frugal-local'));
  await router.complete(msgs, [], 'fast');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.url, /^http:\/\/127\.0\.0\.1:11434/);
});

test('confidential repo with a non-local "local" model URL refuses to start', () => {
  const cfg = loadConfig();
  cfg.ollamaUrl = 'http://models.example.com:11434';
  const policy = resolvePolicy(tempRepo({ '.frugal.json': '{"confidential": true}' }));
  assert.throws(() => new Router(cfg, policy, new Budget(cfg), new FakeFrontend(), emptyStats()), /not on this machine/);
});

test('budget: over the limit, nothing is sent at all', async () => {
  const { router } = setup({ limitUsd: 0.0000001 });
  const sent = fakeNetwork(() => reply('groq', 'x'));
  await assert.rejects(router.complete(msgs, [], 'fast'), BudgetExceededError);
  assert.equal(sent.length, 0);
});

test('budget: after the user picks the local model, calls are free and go through', async () => {
  const { cfg, router } = setup({ limitUsd: 0.0000001 });
  const sent = fakeNetwork(() => reply('ollama', 'frugal-local'));
  router.setUserLocalOnly(true);
  await router.complete(msgs, [], 'fast');
  assert.equal(sent[0]!.body.model, cfg.models.local);
  assert.equal(sent[0]!.vk, cfg.virtualKeys.local);
});

test('budget: a 402 from the gateway is treated as the limit, not as an outage', async () => {
  const { router } = setup();
  fakeNetwork(() => ({ status: 402, json: { type: 'budget_exceeded', error: { message: 'Budget exceeded' } } }));
  await assert.rejects(router.complete(msgs, [], 'fast'), BudgetExceededError);
});

test('failover: the user is told when another model takes over', async () => {
  const { router, fe, stats } = setup();
  fakeNetwork((_, n) =>
    n === 1 ? reply('groq', 'llama-3.3-70b-versatile') : reply('gemini', 'gemini-2.5-flash-lite', { is_fallback: true, primary_provider: 'groq', primary_model: 'llama-3.3-70b-versatile' }),
  );
  await router.complete(msgs, [], 'fast');
  await router.complete(msgs, [], 'fast');
  const switches = fe.ofType('model');
  assert.equal(switches.length, 2);
  assert.equal(switches[1]!.previous, 'groq/llama-3.3-70b-versatile');
  assert.equal(switches[1]!.model, 'gemini/gemini-2.5-flash-lite');
  assert.match(switches[1]!.reason, /unavailable, failed over/);
  assert.equal(stats.failovers, 1);
});

test('outage: rate limits are retried, then the session continues on the local model', async () => {
  const { router, fe } = setup();
  const sent = fakeNetwork((s) => (s.url.includes(':8080') ? { status: 429, json: { error: { message: 'rate limited' } } } : reply('ollama', 'frugal-local')));
  const out = await router.complete(msgs, [], 'fast');
  assert.equal(sent.filter((s) => s.url.includes(':8080')).length, 3, 'three attempts through the gateway');
  assert.match(out.model, /^ollama\//);
  assert.ok(fe.ofType('notice').some((n) => /session is not lost/.test(n.text)));
});

test('outage: gateway process down, session continues on the local model directly', async () => {
  const { router } = setup();
  fakeNetwork((s) => (s.url.includes(':8080') ? 'down' : reply('ollama', 'frugal-local')));
  const out = await router.complete(msgs, [], 'fast');
  assert.match(out.model, /^ollama\//);
});

test('content returned as a list of parts is flattened to text', async () => {
  const { router } = setup();
  fakeNetwork(() => ({
    status: 200,
    json: { choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed ' }, { type: 'text', text: 'it.' }] } }], model: 'openai/gpt-oss-20b', extra_fields: { provider: 'groq' } },
  }));
  const out = await router.complete(msgs, [], 'fast');
  assert.equal(out.message.content, 'Fixed it.');
});

test('a streamed reply is assembled from fragments: text, a split tool call, usage and the answering model', async () => {
  const sse = (chunks: object[]) => {
    const text = `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
    // Deliver in awkward slices, so lines are cut mid-way as they are on a real connection.
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37));
        controller.close();
      },
    });
  };
  const seen: string[] = [];
  const raw = await readStream(
    sse([
      { choices: [{ delta: { role: 'assistant', content: '' } }], extra_fields: { routing_info: { provider: 'gemini', model: 'gemini-3.5-flash-lite' } } },
      { choices: [{ delta: { content: 'Fixing ' } }] },
      { choices: [{ delta: { content: 'the bug.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'edit', arguments: '{"path":"a.js",' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"old":"x","new":"y"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30 }, model: 'gemini-3.5-flash-lite' },
    ]),
    (d) => seen.push(d),
  );
  assert.deepEqual(seen, ['Fixing ', 'the bug.']);
  const message = raw.choices![0]!.message!;
  assert.equal(message.content, 'Fixing the bug.');
  assert.deepEqual(JSON.parse(message.tool_calls![0]!.function.arguments), { path: 'a.js', old: 'x', new: 'y' });
  assert.equal(message.tool_calls![0]!.function.name, 'edit');
  assert.equal(raw.usage!.prompt_tokens, 120);
  assert.equal(raw.extra_fields!.routing_info!.provider, 'gemini');
});

test('a bad request is an error, not something to retry or reroute', async () => {
  const { router } = setup();
  const sent = fakeNetwork(() => ({ status: 400, json: { error: { message: 'bad tool schema' } } }));
  await assert.rejects(router.complete(msgs, [], 'fast'), /bad tool schema/);
  assert.equal(sent.length, 1);
});

test('tool calls written as text by small models: only the first is run', () => {
  const known = new Set(['read', 'edit', 'sh']);
  const text = '{"name": "read", "arguments": {"path": "a.js"}}\n{"name": "edit", "arguments": {"path": "a.js", "old": "guess", "new": "x"}}\n{"name": "sh", "arguments": {"cmd": "npm test"}}';
  const calls = toolCallsOf({ role: 'assistant', content: text }, known);
  assert.equal(calls.fromText, true);
  assert.equal(calls.list.length, 1);
  assert.equal(calls.list[0]!.function.name, 'read');
  assert.equal(toolCallsOf({ role: 'assistant', content: 'Use {"name": "rm_rf", "arguments": {}}' }, known).list.length, 0);
});
