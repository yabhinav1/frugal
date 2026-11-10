import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, budgetOf, configuredProviders, providerKeyEnvs, type Config } from '../config.ts';

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
  const vkCloud = `vk-${cfg.user}`;
  const vkLocal = `vk-${cfg.user}-local`;

  return {
    $schema: 'https://www.getbifrost.ai/schema',
    client: { enable_logging: true, enforce_auth_on_inference: true, drop_excess_requests: false },
    providers,
    governance: {
      virtual_keys: [
        { id: vkCloud, name: cfg.user, value: cfg.virtualKeys.cloud, is_active: true, provider_configs: [...cloud, 'ollama'].map(allow) },
        { id: vkLocal, name: `${cfg.user}-local`, value: cfg.virtualKeys.local, is_active: true, provider_configs: [allow('ollama')] },
      ],
      budgets: [{ id: `budget-${cfg.user}`, max_limit: budgetOf(cfg).limitUsd, reset_duration: RESET[budgetOf(cfg).period], virtual_key_id: vkCloud }],
    },
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
  if (mode === 'detached') child.unref();
  return child;
}

/** Make sure a gateway is serving, starting one in the background if needed. */
export async function ensureGateway(cfg: Config, onWait?: () => void, timeoutMs = 90_000): Promise<boolean> {
  if (await gatewayHealthy(cfg)) return true;
  onWait?.();
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
