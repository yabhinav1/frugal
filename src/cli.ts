import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.ts';
import type { PreApprovals } from './approval.ts';
import { Budget } from './budget.ts';
import { CONFIG_FILE, HOME, PROVIDER_KEY_ENV, budgetOf, configuredProviders, loadConfig, loadEnv, providerKeyEnvs, updateStoredConfig, type Config } from './config.ts';
import { BIFROST_DIR, ensureGateway, gatewayHealthy, startGateway, writeBifrostConfig } from './gateway/bifrost.ts';
import { checkKeys } from './gateway/keys.ts';
import { ensureLocalModel } from './gateway/ollama.ts';
import { findRepoRoot, markConfidential, resolvePolicy, unmarkConfidential, type Policy } from './policy.ts';
import { listSessions, loadSession, newSession, type Session } from './session.ts';
import type { Frontend, Tier } from './types.ts';
import { JsonFrontend, TerminalUI } from './ui/terminal.ts';
import { c, fmtTokens, fmtUsd } from './util.ts';
import { startWebServer } from './web/server.ts';

const HELP = `frugal - a coding agent that gets the job done on the fewest tokens

Usage
  frugal                       chat in this repository (like claude or codex)
  frugal "fix the failing test"  run one task and exit
  frugal web [--port 4317]     open the same agent in your browser
  frugal gateway               run the Bifrost gateway in this terminal
  frugal init                  first-time setup: create the key file and show next steps
  frugal doctor                check gateway, models, keys and policy
  frugal keys                  test every API key and drop dead ones from the pools
  frugal sessions              list saved sessions for this repository
  frugal budget [set <usd>] [day|month]
  frugal repo status | mark | unmark    confidential mode for this repository

Options
  -c, --continue               continue the latest session in this repository
  --resume <id>                continue a specific session
  --confidential               treat this repository as confidential for this run
  --yes-writes                 approve file edits up front (shell and git still ask)
  --allow-cmd "<command>"      approve one exact command up front (repeatable)
  --tier fast|strong|local     pin the model tier
  --json                       print events as JSON lines (for scripts and benchmarks)
  --no-gateway                 do not start Bifrost automatically
  --user <name>                spend against this user's budget`;

interface Args {
  command: string;
  rest: string[];
  continue: boolean;
  resume?: string;
  confidential: boolean;
  yesWrites: boolean;
  allowCmd: string[];
  tier?: Tier;
  json: boolean;
  noGateway: boolean;
  user?: string;
  port?: number;
  help: boolean;
}

const COMMANDS = new Set(['web', 'gateway', 'doctor', 'keys', 'init', 'sessions', 'budget', 'repo', 'run', 'help']);

function parseArgs(argv: string[]): Args {
  const a: Args = { command: '', rest: [], continue: false, confidential: false, yesWrites: false, allowCmd: [], json: false, noGateway: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (t === '-c' || t === '--continue') a.continue = true;
    else if (t === '--resume') a.resume = next();
    else if (t === '--confidential') a.confidential = true;
    else if (t === '--yes-writes') a.yesWrites = true;
    else if (t === '--allow-cmd') a.allowCmd.push(next());
    else if (t === '--tier') a.tier = next() as Tier;
    else if (t === '--json') a.json = true;
    else if (t === '--no-gateway') a.noGateway = true;
    else if (t === '--user') a.user = next();
    else if (t === '--port') a.port = Number(next());
    else if (t === '-h' || t === '--help') a.help = true;
    else if (!a.command && a.rest.length === 0 && COMMANDS.has(t)) a.command = t;
    else a.rest.push(t);
  }
  if (a.tier && !['fast', 'strong', 'local'].includes(a.tier)) throw new Error(`Unknown tier "${a.tier}". Use fast, strong or local.`);
  return a;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help || args.command === 'help') return void console.log(HELP);

  loadEnv();
  const cfg = loadConfig();
  if (args.user) cfg.user = args.user;

  switch (args.command) {
    case 'gateway':
      return gatewayCommand(cfg);
    case 'doctor':
      return doctor(cfg, args);
    case 'keys':
      return keysCommand();
    case 'init':
      return initCommand();
    case 'sessions':
      return sessionsCommand();
    case 'budget':
      return budgetCommand(cfg, args.rest, !!args.user);
    case 'repo':
      return repoCommand(cfg, args.rest);
    case 'web':
      return webCommand(cfg, args);
    default:
      return chat(cfg, args);
  }
}

// ---- shared setup ----

function pickSession(args: Args, policy: Policy): Session {
  if (args.resume) {
    const s = loadSession(args.resume);
    if (!s) throw new Error(`No saved session "${args.resume}". Run: frugal sessions`);
    return s;
  }
  if (args.continue) {
    const latest = listSessions(policy.root)[0];
    if (latest) return latest;
  }
  return newSession(policy.root);
}

function buildAgent(cfg: Config, args: Args, policy: Policy, session: Session, frontend: Frontend): Agent {
  const pre: PreApprovals = { writes: args.yesWrites, commands: args.allowCmd };
  return new Agent({ cfg, policy, session, frontend, pre, forceTier: args.tier });
}

async function prepareGateway(cfg: Config, args: Args, say: (s: string) => void): Promise<void> {
  const local = await ensureLocalModel(cfg);
  if (local === 'created') say(c.dim(`  Created local model ${cfg.models.local} (${cfg.localBase} with a ${cfg.localContextTokens}-token context).`));
  else if (local === 'no-ollama') say(c.yellow('  ! Ollama is not running, so there is no local model to fall back on (and confidential repos cannot be used).'));
  else if (local === 'no-base') say(c.yellow(`  ! Local model missing. Run: ollama pull ${cfg.localBase}`));
  if (args.noGateway) return;
  const up = await ensureGateway(cfg, () => say(c.dim('  Starting the Bifrost gateway in the background (first run downloads it)…')));
  if (!up) say(c.yellow('  ! Bifrost did not come up. Calls will use the local model directly until it does. Try: frugal gateway'));
}

function banner(cfg: Config, policy: Policy, agent: Agent, session: Session): string {
  const b = new Budget(cfg).status();
  const chain = agent.router.chain(session.tier);
  const lines = [
    `${c.bold('frugal')} ${c.dim(`· ${path.basename(policy.root)} · session ${session.id}`)}`,
    policy.confidential
      ? c.magenta(`  ■ CONFIDENTIAL repository (${policy.sources.join(', ')}): local model only, web search off`)
      : c.dim(`  models: ${chain.join(' → ')}`),
    c.dim(`  budget: ${fmtUsd(b.spentUsd)} of ${fmtUsd(b.limitUsd)} this ${b.period} (${b.user}) · reads are free; writes, shell and git ask first`),
  ];
  if (session.messages.length) lines.push(c.dim(`  resumed: "${session.title}" (${session.messages.length} messages)`));
  return lines.join('\n');
}

// ---- chat (interactive and one-shot) ----

async function chat(cfg: Config, args: Args): Promise<void> {
  const task = args.rest.join(' ').trim();
  const policy = resolvePolicy(process.cwd(), { forceConfidential: args.confidential });
  const session = pickSession(args, policy);

  if (args.json) {
    if (!task) throw new Error('--json needs a task: frugal --json "your task"');
    const fe = new JsonFrontend();
    await prepareGateway(cfg, args, () => {});
    const agent = buildAgent(cfg, args, policy, session, fe);
    await agent.runTurn(task);
    process.stdout.write(`${JSON.stringify({ type: 'result', session: session.id, stats: session.stats })}\n`);
    // Set the code and let Node drain: a hard exit here can crash libuv on Windows.
    process.exitCode = fe.exitCode;
    return;
  }

  // FRUGAL_INTERACTIVE=1 lets a script answer the prompts through a pipe (used by demos and tests).
  const interactive = !!process.stdin.isTTY || process.env.FRUGAL_INTERACTIVE === '1';
  const ui = new TerminalUI(interactive);
  await prepareGateway(cfg, args, (s) => ui.print(s));
  const agent = buildAgent(cfg, args, policy, session, ui);
  ui.print(banner(cfg, policy, agent, session));

  if (task) {
    await ui.turn(agent, task);
    ui.close();
    process.exitCode = ui.exitCode;
    return;
  }
  if (!interactive) throw new Error('No task given and no terminal to chat in. Usage: frugal "your task"');

  ui.print(c.dim('  Type a task. /help for commands, Ctrl+C stops a running turn, /exit quits.\n'));
  for (;;) {
    const line = await ui.ask(c.cyan('› '));
    if (ui.inputClosed) break;
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') {
      ui.print(c.dim('  /cost  token and cost breakdown by model\n  /status  budget, models and policy\n  /web  how to open this in the browser\n  /exit  quit (the session is saved; frugal -c continues it)'));
      continue;
    }
    if (line === '/cost') {
      const s = session.stats;
      ui.print(c.dim(`  ${s.calls} model calls, ${s.toolCalls} tool calls, ${fmtTokens(s.tokensIn)} in / ${fmtTokens(s.tokensOut)} out, ${fmtTokens(s.tokensSaved)} tokens saved, ${s.failovers} failovers, ${fmtUsd(s.costUsd)}`));
      for (const [model, m] of Object.entries(s.byModel)) ui.print(c.dim(`    ${model}: ${m.calls} calls, ${fmtTokens(m.tokensIn)} in / ${fmtTokens(m.tokensOut)} out, ${fmtUsd(m.costUsd)}`));
      continue;
    }
    if (line === '/status') {
      ui.print(banner(cfg, policy, agent, session));
      continue;
    }
    if (line === '/web') {
      ui.print(c.dim(`  Quit, then run: frugal web --resume ${session.id}`));
      continue;
    }
    if (line.startsWith('/')) {
      ui.print(c.yellow(`  Unknown command ${line}. Try /help.`));
      continue;
    }
    await ui.turn(agent, line);
  }
  ui.close();
  console.log(c.dim(`  Session saved. Continue it with: frugal -c`));
}

// ---- web ----

async function webCommand(cfg: Config, args: Args): Promise<void> {
  const policy = resolvePolicy(process.cwd(), { forceConfidential: args.confidential });
  const session = pickSession(args, policy);
  await prepareGateway(cfg, args, (s) => console.log(s));
  const { url } = await startWebServer({ cfg, policy, session, port: args.port ?? 4317, pre: { writes: args.yesWrites, commands: args.allowCmd }, forceTier: args.tier });
  console.log(`${c.bold('frugal web')} ${c.dim(`· ${path.basename(policy.root)} · session ${session.id}`)}`);
  console.log(`  Open ${c.cyan(url)}`);
  console.log(c.dim('  The link carries your access token and only works from this computer. Once signed in, plain http://127.0.0.1:' + (args.port ?? 4317) + ' works too. Ctrl+C stops the server.'));
}

// ---- gateway ----

async function gatewayCommand(cfg: Config): Promise<void> {
  if (await gatewayHealthy(cfg)) {
    console.log(`Bifrost is already running at ${cfg.gatewayUrl}. Stop that one first to apply config changes.`);
    return;
  }
  const file = writeBifrostConfig(cfg);
  const cloud = configuredProviders();
  console.log(c.dim(`Config written to ${file}`));
  console.log(c.dim(`Providers: ${[...cloud, 'ollama'].join(', ')}${cloud.length ? '' : '  (no cloud keys found in .env yet)'}`));
  console.log(c.dim(`Budget for ${cfg.user}: ${fmtUsd(cfg.budget.limitUsd)} per ${cfg.budget.period}. Starting Bifrost on ${cfg.gatewayUrl}…\n`));
  const child = startGateway(cfg, 'foreground');
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
}

// ---- doctor ----

async function doctor(cfg: Config, args: Args): Promise<void> {
  const ok = (good: boolean, text: string) => console.log(`  ${good ? c.green('✓') : c.red('✗')} ${text}`);
  console.log(c.bold('frugal doctor'));
  console.log(c.dim(`  home ${HOME} · config ${CONFIG_FILE} · gateway data ${BIFROST_DIR}`));

  const policy = resolvePolicy(process.cwd(), { forceConfidential: args.confidential });
  ok(true, `repository ${policy.root} · ${policy.confidential ? `CONFIDENTIAL (${policy.sources.join(', ')})` : 'not confidential'}`);

  for (const [provider, env] of Object.entries(PROVIDER_KEY_ENV)) {
    const found = providerKeyEnvs(provider);
    ok(found.length > 0, found.length ? `${provider}: ${found.length} key${found.length > 1 ? 's' : ''} (${found.join(', ')})` : `${provider} key (${env}) missing`);
  }
  ok(!!process.env.TAVILY_API_KEY, `Tavily key (TAVILY_API_KEY)${process.env.TAVILY_API_KEY ? '' : ' missing: web search is off'}`);

  const local = await ensureLocalModel(cfg);
  if (local === 'no-ollama') ok(false, `Ollama not reachable at ${cfg.ollamaUrl}`);
  else if (local === 'no-base') ok(false, `Local model missing. Run: ollama pull ${cfg.localBase}`);
  else ok(true, `Ollama at ${cfg.ollamaUrl} · local model ${cfg.models.local} (${cfg.localContextTokens}-token context)${local === 'created' ? ' created just now' : ''}`);

  const up = await gatewayHealthy(cfg);
  ok(up, `Bifrost gateway at ${cfg.gatewayUrl}${up ? '' : ' not running (frugal starts it automatically, or run: frugal gateway)'}`);
  if (!up) return;

  // Live checks through the gateway, each a few tokens.
  const ping = async (vk: string, model: string) => {
    const res = await fetch(`${cfg.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bf-vk': vk },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with: ok' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let detail = text.slice(0, 120);
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      /* keep raw text */
    }
    return { status: res.status, detail };
  };
  const models = [...new Set([...cfg.models.fast, ...cfg.models.strong])].filter((m) => configuredProviders().includes(m.split('/')[0]!));
  for (const model of [...models, cfg.models.local]) {
    try {
      const r = await ping(cfg.virtualKeys.cloud, model);
      ok(r.status === 200, `${model} ${r.status === 200 ? 'responds' : `HTTP ${r.status}: ${r.detail}`}`);
    } catch (err) {
      ok(false, `${model}: ${(err as Error).message}`);
    }
  }
  // The privacy guarantee, tested for real: the local-only key must be refused a cloud model.
  if (models[0]) {
    const r = await ping(cfg.virtualKeys.local, models[0]);
    ok(r.status !== 200, `confidential key is refused cloud model ${models[0]} (HTTP ${r.status})`);
  }
  const noKey = await ping('', cfg.models.local);
  ok(noKey.status === 401, `requests without a virtual key are rejected (HTTP ${noKey.status})`);
}

// ---- init ----

/** First-run setup: create the key file in the user's home and say what to put in it. */
function initCommand(): void {
  const file = path.join(HOME, '.env');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(
      file,
      [
        '# API keys for frugal. This file stays on your machine.',
        '# One free key from either provider is enough to start. Add more with a suffix (GROQ_API_KEY_2) to pool them.',
        'GEMINI_API_KEY=',
        'GROQ_API_KEY=',
        '# Optional: web search',
        'TAVILY_API_KEY=',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    console.log(`Created ${file}`);
  } else console.log(`Key file already exists: ${file}`);
  console.log('1. Put at least one key in it (free: https://aistudio.google.com/apikey or https://console.groq.com/keys).');
  console.log('2. Optional, for confidential repos and offline fallback: install Ollama and run  ollama pull qwen2.5-coder:3b');
  console.log('3. Run  frugal doctor  to check everything, then  frugal  inside any repository.');
}

// ---- keys ----

/** Test every API key in .env. Dead keys are recorded and left out of the gateway's pools. */
async function keysCommand(): Promise<void> {
  console.log(c.bold('frugal keys') + c.dim('  testing every key against its provider (no tokens spent)…'));
  const results = await checkKeys();
  if (!results.length) return void console.log('  No provider keys found in .env.');
  for (const provider of [...new Set(results.map((r) => r.provider))]) {
    const rows = results.filter((r) => r.provider === provider);
    const live = rows.filter((r) => r.ok).length;
    console.log(`\n  ${c.bold(provider)}: ${live} of ${rows.length} in the pool`);
    for (const r of rows) console.log(`    ${r.ok ? c.green('✓') : c.red('✗')} ${r.env.padEnd(22)} ${c.dim(r.detail)}`);
  }
  console.log(c.dim('\n  Restart the gateway to apply: stop it, then run "frugal gateway" (or just run frugal).'));
}

// ---- small commands ----

function sessionsCommand(): void {
  const root = findRepoRoot(process.cwd());
  const sessions = listSessions(root);
  if (!sessions.length) return void console.log('No saved sessions for this repository.');
  for (const s of sessions.slice(0, 20)) {
    console.log(`${c.cyan(s.id)}  ${c.dim(s.updatedAt.slice(0, 16).replace('T', ' '))}  ${fmtUsd(s.stats.costUsd).padEnd(9)} ${s.title || '(empty)'}`);
  }
  console.log(c.dim('\nContinue one with: frugal --resume <id>'));
}

/** `frugal budget set 0.5` sets the default for everyone; with `--user name` it sets that person's own limit. */
function budgetCommand(cfg: Config, rest: string[], forUser: boolean): void {
  if (rest[0] === 'set') {
    const limit = Number(rest[1]);
    if (!(limit >= 0)) throw new Error('Usage: frugal budget set <usd> [day|month]');
    const period = rest[2] === 'day' || rest[2] === 'month' ? rest[2] : budgetOf(cfg).period;
    if (forUser) {
      cfg.userBudgets[cfg.user] = { limitUsd: limit, period };
      updateStoredConfig({ userBudgets: cfg.userBudgets });
    } else {
      cfg.budget = { limitUsd: limit, period };
      updateStoredConfig({ budget: cfg.budget });
    }
    console.log('Saved. Restart the gateway (frugal gateway) so Bifrost enforces the same limit.');
  }
  const b = new Budget(cfg).status();
  console.log(`${b.user}: spent ${fmtUsd(b.spentUsd)} of ${fmtUsd(b.limitUsd)} this ${b.period}`);
}

async function repoCommand(cfg: Config, rest: string[]): Promise<void> {
  const root = findRepoRoot(process.cwd());
  const sub = rest[0] ?? 'status';
  if (sub === 'mark') {
    markConfidential(root, `${cfg.user} via CLI`);
    console.log(`Marked confidential: ${root}\nOnly the local model will ever see this repository, and web search is off.`);
  } else if (sub === 'unmark') {
    // Deliberately needs a human at a keyboard: the agent cannot answer this prompt.
    if (!process.stdin.isTTY) throw new Error('unmark must be run by a person in an interactive terminal.');
    const ui = new TerminalUI(true);
    const answer = await ui.ask(`Type the repository folder name (${path.basename(root)}) to confirm it may be sent to cloud models: `);
    ui.close();
    if (answer !== path.basename(root)) return void console.log('Not changed.');
    unmarkConfidential(root);
    console.log('Removed from the confidential registry. If the repo still has a .frugal/policy.json marker, it stays confidential.');
  } else {
    const policy = resolvePolicy(root);
    console.log(`${root}\n${policy.confidential ? `CONFIDENTIAL (${policy.sources.join(', ')})` : 'not confidential'}`);
  }
}
