import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HOME, configuredProviders, providerKeyEnvs, type Config } from '../config.ts';
import { readJson, writeJsonAtomic } from '../util.ts';

export const BIFROST_DIR = process.env.FRUGAL_BIFROST_DIR || path.join(HOME, 'bifrost');

const RESET: Record<Config['budget']['period'], string> = { day: '1d', month: '1M' };

/**
 * Generate Bifrost's config.json from our config.
 *
 * Two virtual keys per user:
 *  - the cloud key may reach every configured provider and carries the user's budget;
 *  - the local key may reach Ollama only. Confidential sessions are given this key and no
 *    other, so the gateway refuses a cloud model even if the agent were tricked into asking.
 */
export function buildBifrostConfig(cfg: Config): Record<string, unknown> {
  const cloud = configuredProviders();
  const providers: Record<string, unknown> = {};
  const chainModels = [...new Set([...cfg.models.fast, ...cfg.models.strong])];
  const isProModel = (model: string) => /(^|[-/])pro([-/]|$)/.test(model);
  for (const name of cloud) {
    const envs = providerKeyEnvs(name);
    const hasProKey = envs.some((e) => e.endsWith('_PRO'));
    // Ordinary keys, when a paid key exists beside them, are limited to the non-pro models in
    // our chains, so a pro request is never handed to a key without quota for it.
    const ordinary = chainModels.filter((m) => m.startsWith(`${name}/`) && !isProModel(m)).map((m) => m.slice(name.length + 1));
    providers[name] = {
      // Several keys for one provider are balanced equally, multiplying the free-tier rate limit.
      keys: envs.map((envName, i) => ({
        name: `${name}-key-${i + 1}${envName.endsWith('_PRO') ? '-pro' : ''}`,
        value: `env.${envName}`,
        models: hasProKey && !envName.endsWith('_PRO') ? ordinary : ['*'],
        weight: 1.0,
      })),
      // With one key, retrying a rate-limited provider is pointless: the next model in the chain
      // answers sooner. With a pool, a retry draws another key, so a few quick retries are worth it.
      network_config: { max_retries: Math.min(3, envs.length - 1), retry_backoff_initial: 200, retry_backoff_max: 1000, default_request_timeout_in_seconds: 60 },
    };
  }
  providers.ollama = {
    keys: [{ name: 'ollama-local', value: '', models: ['*'], weight: 1.0, ollama_key_config: { url: cfg.ollamaUrl } }],
    network_config: { allow_private_network: true, default_request_timeout_in_seconds: 300 },
  };

  const allow = (provider: string) => ({ provider, allowed_models: ['*'], key_ids: ['*'], weight: 1.0 });
  const slug = (user: string) => user.replace(/[^\w.-]+/g, '_');

  // Every known user gets their own pair of keys and their own budget at the gateway.
  const virtual_keys: unknown[] = [];
  const budgets: unknown[] = [];
  for (const [user, keys] of Object.entries(cfg.userKeys).sort(([a], [b]) => a.localeCompare(b))) {
    const limit = cfg.userBudgets[user] ?? cfg.budget;
    virtual_keys.push(
      { id: `vk-${slug(user)}`, name: user, value: keys.cloud, is_active: true, provider_configs: [...cloud, 'ollama'].map(allow) },
      { id: `vk-${slug(user)}-local`, name: `${user}-local`, value: keys.local, is_active: true, provider_configs: [allow('ollama')] },
    );
    budgets.push({ id: `budget-${slug(user)}`, max_limit: limit.limitUsd, reset_duration: RESET[limit.period], virtual_key_id: `vk-${slug(user)}` });
  }

  return {
    $schema: 'https://www.getbifrost.ai/schema',
    client: { enable_logging: true, enforce_auth_on_inference: true, drop_excess_requests: false },
    providers,
    governance: { virtual_keys, budgets },
  };
}

export function writeBifrostConfig(cfg: Config): string {
  fs.mkdirSync(BIFROST_DIR, { recursive: true });
  const file = path.join(BIFROST_DIR, 'config.json');
  fs.writeFileSync(file, JSON.stringify(buildBifrostConfig(cfg), null, 2));
  return file;
}

/**
 * Start Bifrost. In the foreground its logs go to this terminal; detached, it keeps serving after
 * the agent exits, so the next `frugal` starts instantly.
 */
export function startGateway(cfg: Config, mode: 'foreground' | 'detached' = 'foreground'): ChildProcess {
  writeBifrostConfig(cfg);
  const url = new URL(cfg.gatewayUrl);
  // npx is a .cmd shim on Windows and needs a shell; one command string avoids unescaped-args pitfalls.
  const command = `npx -y @maximhq/bifrost -app-dir "${BIFROST_DIR}" -port ${Number(url.port) || 8080} -host ${url.hostname}`;
  const child = spawn(command, {
    stdio: mode === 'foreground' ? 'inherit' : 'ignore',
    shell: true,
    env: process.env,
    detached: mode === 'detached',
    windowsHide: true,
  });
  if (mode === 'detached') {
    child.unref();
    // Remember what this gateway was started with, so a later config change can restart it.
    writeJsonAtomic(STATE, { hash: configHash(cfg), startedAt: new Date().toISOString() });
  } else fs.rmSync(STATE, { force: true }); // a gateway run by hand is never restarted for the user
  return child;
}

const STATE = path.join(HOME, 'gateway.json');

/** Fingerprint of everything the gateway is started with: its config and the API keys behind it. */
function configHash(cfg: Config): string {
  const keys = configuredProviders().flatMap((p) => providerKeyEnvs(p).map((env) => `${env}=${process.env[env]}`));
  return crypto.createHash('sha256').update(JSON.stringify(buildBifrostConfig(cfg))).update(keys.join('\n')).digest('hex').slice(0, 16);
}

/** The process listening on the gateway's port, if it is a Bifrost process. */
function gatewayPid(cfg: Config): number | null {
  const port = Number(new URL(cfg.gatewayUrl).port) || 8080;
  if (process.platform === 'win32') {
    const net = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    const line = net.split(/\r?\n/).find((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l));
    const pid = Number(line?.trim().split(/\s+/).pop());
    if (!pid) return null;
    const name = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    return /bifrost/i.test(name) ? pid : null;
  }
  const pid = Number((spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '').trim().split('\n')[0]);
  if (!pid) return null;
  const name = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).stdout ?? '';
  return /bifrost/i.test(name) ? pid : null;
}

/** Stop the Bifrost process on the gateway port. Anything else on that port is left alone. */
export async function stopGateway(cfg: Config): Promise<boolean> {
  const pid = gatewayPid(cfg);
  if (!pid) return false;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20 && (await gatewayHealthy(cfg, 500)); i++) await new Promise((r) => setTimeout(r, 250));
  fs.rmSync(STATE, { force: true });
  return true;
}

/**
 * Make sure a gateway is serving with the current settings. Starts one in the background if
 * none is running. If the one running is ours and was started before the keys, users or budgets
 * changed, it is restarted so the change takes effect; a gateway someone started by hand is
 * left alone.
 */
export async function ensureGateway(cfg: Config, onWait?: (why: 'starting' | 'restarting') => void, timeoutMs = 90_000): Promise<boolean> {
  if (await gatewayHealthy(cfg)) {
    const state = readJson<{ hash?: string } | null>(STATE, null);
    if (!state || state.hash === configHash(cfg)) return true;
    onWait?.('restarting');
    await stopGateway(cfg);
  } else onWait?.('starting');
  startGateway(cfg, 'detached');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await gatewayHealthy(cfg)) return true;
  }
  return false;
}

export async function gatewayHealthy(cfg: Config, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.gatewayUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}
