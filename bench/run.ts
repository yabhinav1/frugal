// Benchmark: the same tasks, the same model, the same gateway, two agents.
//
//   node bench/run.ts [--model groq/openai/gpt-oss-20b] [--tasks 01,05] [--variants frugal,naive] [--delay 5]
//
// "frugal" is the agent as shipped. "naive" is the same loop with the token-saving behaviour
// switched off (see AgentOptions.naive). A task counts as solved only if the project's whole
// test suite passes afterwards, with the task's test file restored to its original content.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = path.join(ROOT, '.bench');
const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

// Benchmark runs get their own home (ledger, sessions) but reuse the real gateway keys.
const realHome = process.env.FRUGAL_HOME || path.join(os.homedir(), '.frugal');
const benchHome = path.join(BENCH, 'home');
fs.mkdirSync(benchHome, { recursive: true });
const realConfig = JSON.parse(fs.readFileSync(path.join(realHome, 'config.json'), 'utf8')) as { virtualKeys: unknown };
fs.writeFileSync(path.join(benchHome, 'config.json'), JSON.stringify({ virtualKeys: realConfig.virtualKeys }));
process.env.FRUGAL_HOME = benchHome;
process.env.FRUGAL_BIFROST_DIR = path.join(realHome, 'bifrost');

const { loadConfig, loadEnv, isLocalModel } = await import('../src/config.ts');
const { Agent } = await import('../src/agent.ts');
const { resolvePolicy } = await import('../src/policy.ts');
const { newSession } = await import('../src/session.ts');
const { ensureGateway } = await import('../src/gateway/bifrost.ts');
type AgentEvent = import('../src/types.ts').AgentEvent;
type Frontend = import('../src/types.ts').Frontend;
type Stats = import('../src/types.ts').Stats;

interface Task {
  id: string;
  kind: string;
  prompt: string;
}
interface Result {
  task: string;
  kind: string;
  variant: string;
  model: string;
  solved: boolean;
  end: string;
  tokensIn: number;
  tokensOut: number;
  calls: number;
  toolCalls: number;
  tokensSaved: number;
  costUsd: number;
  seconds: number;
  /** Another model answered part of the run (rate limit failover), so it is not a clean comparison. */
  mixedModels: boolean;
  attempts: number;
  testTampered: boolean;
  /** Which repeat this is (1-based). Models are not deterministic, so each task is run several times. */
  run: number;
}

loadEnv();
const cfg = loadConfig();
const model = flag('model', cfg.models.fast[0]!);
cfg.user = 'bench';
cfg.userBudgets.bench = { limitUsd: 10, period: 'day' };
// The model is listed three times so that a one-off provider error (some models occasionally
// emit a malformed tool call, which the provider rejects) retries the same model instead of
// failing over to a different one and spoiling the comparison.
cfg.models.fast = [model, model, model];
const delayMs = Number(flag('delay', '5')) * 1000;
const variants = flag('variants', 'frugal,naive').split(',');
const only = flag('tasks', '');
const tasks = (JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/tasks/tasks.json'), 'utf8')) as Task[]).filter((t) => !only || only.split(',').some((p) => t.id.startsWith(p)));
const resultsFile = path.join(BENCH, `results-${model.replace(/[^\w.-]+/g, '_')}.json`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (file: string) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

function prepare(task: Task, variant: string): string {
  // One folder per model as well, so two benchmark runs can never share a working copy.
  const dir = path.join(BENCH, 'work', model.replace(/[^\w.-]+/g, '_'), variant, task.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'bench/fixture'), dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'bench/tasks', `${task.id}.test.js`), path.join(dir, 'test', `${task.id}.test.js`));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', 'fixture'], { cwd: dir });
  return dir;
}

async function runOnce(task: Task, variant: string): Promise<Omit<Result, 'attempts' | 'run'>> {
  const dir = prepare(task, variant);
  const testFile = path.join(dir, 'test', `${task.id}.test.js`);
  const original = fs.readFileSync(testFile);
  const before = sha(testFile);

  let end = 'unknown';
  // Stands in for a person who approves ordinary edits and commands, and refuses git and anything risky.
  const frontend: Frontend = {
    emit(e: AgentEvent) {
      if (e.type === 'turn_end') end = e.reason === 'error' ? `error: ${e.error}` : e.reason;
    },
    approve: async (req) => ({ allow: (req.category === 'write' || req.category === 'shell') && req.warnings.length === 0 }),
    budgetLimit: async () => ({ action: 'stop' }),
  };
  const session = newSession(dir);
  // Benchmarking the local model means benchmarking confidential mode, exactly as a user gets it.
  const policy = resolvePolicy(dir, { forceConfidential: isLocalModel(model) });
  const agent = new Agent({ cfg, policy, session, frontend, pre: { writes: false, commands: [] }, forceTier: isLocalModel(model) ? 'local' : 'fast', naive: variant === 'naive' });

  // Hold every call to the one model under test: wait out provider overloads, never substitute.
  agent.router.pinned = true;

  const started = Date.now();
  const timer = setTimeout(() => agent.stop(), 12 * 60_000);
  await agent.runTurn(task.prompt);
  clearTimeout(timer);

  // An agent that edits the test to make it pass has not solved the task.
  const testTampered = !fs.existsSync(testFile) || sha(testFile) !== before;
  if (testTampered) fs.writeFileSync(testFile, original);
  const check = spawnSync(process.execPath, ['--test'], { cwd: dir, timeout: 120_000 });

  const s: Stats = session.stats;
  return {
    task: task.id,
    kind: task.kind,
    variant,
    model,
    solved: check.status === 0,
    end,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    calls: s.calls,
    toolCalls: s.toolCalls,
    tokensSaved: s.tokensSaved,
    costUsd: s.costUsd,
    seconds: Math.round((Date.now() - started) / 1000),
    mixedModels: Object.keys(s.byModel).some((m) => m !== model),
    testTampered,
  };
}

if (!(await ensureGateway(cfg))) throw new Error('Bifrost gateway is not running.');
const results: Result[] = fs.existsSync(resultsFile) && !only ? [] : fs.existsSync(resultsFile) ? (JSON.parse(fs.readFileSync(resultsFile, 'utf8')) as Result[]) : [];

const runs = Math.max(1, Number(flag('runs', '1')));
console.log(`model ${model} · ${tasks.length} tasks · variants ${variants.join(', ')} · ${runs} run${runs > 1 ? 's' : ''} each\n`);
for (let run = 1; run <= runs; run++)
for (const task of tasks) {
  for (const variant of variants) {
    let result: Result | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await runOnce(task, variant);
      result = { ...r, attempts: attempt, run };
      // A run that failed over to another model is retried after the rate limit window has passed.
      const rateLimited = r.mixedModels || /429|rate|quota|No model reachable/i.test(r.end);
      if (!rateLimited) break;
      console.log(`  ${task.id} ${variant}: another model answered part of the run (${r.end}), retrying in 20s (${attempt}/3)`);
      await sleep(20_000);
    }
    const r = result!;
    const i = results.findIndex((x) => x.task === r.task && x.variant === r.variant && (x.run ?? 1) === run);
    if (i >= 0) results[i] = r;
    else results.push(r);
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(
      `${r.solved ? 'PASS' : 'FAIL'}  ${task.id.padEnd(18)} ${variant.padEnd(7)} ${String(r.tokensIn + r.tokensOut).padStart(7)} tokens  ${String(r.calls).padStart(2)} calls  ${String(r.seconds).padStart(3)}s  ${r.end}${r.mixedModels ? '  [mixed models]' : ''}${r.testTampered ? '  [edited the test]' : ''}`,
    );
    await sleep(delayMs);
  }
}

// ---- report ----
const sum = (rs: Result[], f: (r: Result) => number) => rs.reduce((n, r) => n + f(r), 0);
const total = (r: Result) => r.tokensIn + r.tokensOut;
// Every figure is over all runs of a task: "3/3" solved, tokens and calls as the mean per run.
const mean = (rs: Result[], f: (r: Result) => number) => (rs.length ? Math.round(sum(rs, f) / rs.length) : 0);
const of = (id: string, v: string) => results.filter((r) => r.task === id && r.variant === v);
const lines: string[] = [`## ${model}`, '', '| Task | Kind | frugal solved | mean tokens | mean calls | naive solved | mean tokens | mean calls | Tokens saved |', '|---|---|---|---:|---:|---|---:|---:|---:|'];
const ids = [...new Set(results.map((r) => r.task))].sort();
for (const id of ids) {
  const f = of(id, 'frugal');
  const n = of(id, 'naive');
  const cell = (rs: Result[]) => (rs.length ? `${rs.filter((r) => r.solved).length}/${rs.length} | ${mean(rs, total)} | ${mean(rs, (r) => r.calls)}` : '– | – | –');
  const saving = f.length && n.length ? `${Math.round((1 - mean(f, total) / mean(n, total)) * 100)}%` : '–';
  lines.push(`| ${id} | ${(f[0] ?? n[0])!.kind} | ${cell(f)} | ${cell(n)} | ${saving} |`);
}
lines.push('');
for (const v of ['frugal', 'naive']) {
  const rs = results.filter((r) => r.variant === v);
  if (!rs.length) continue;
  const solved = rs.filter((r) => r.solved);
  lines.push(
    `- **${v}**: solved ${solved.length}/${rs.length} runs · ${sum(rs, total)} tokens in total (${sum(rs, (r) => r.tokensIn)} in, ${sum(rs, (r) => r.tokensOut)} out) · ${solved.length ? Math.round(sum(rs, total) / solved.length) : '–'} tokens per solved run · ${mean(rs, (r) => r.calls)} model calls per run · $${sum(rs, (r) => r.costUsd).toFixed(4)} at list price`,
  );
}
const fAll = results.filter((r) => r.variant === 'frugal');
const nAll = results.filter((r) => r.variant === 'naive');
if (fAll.length && nAll.length) {
  lines.push(`- **Overall**: frugal used ${Math.round((1 - mean(fAll, total) / mean(nAll, total)) * 100)}% fewer tokens per run than naive (${mean(fAll, total)} against ${mean(nAll, total)}).`);
}
const report = lines.join('\n');
fs.writeFileSync(path.join(BENCH, `report-${model.replace(/[^\w.-]+/g, '_')}.md`), report);
console.log(`\n${report}\n\nRaw results: ${resultsFile}`);
