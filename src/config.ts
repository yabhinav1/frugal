import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './util.ts';

/** USD per one million tokens. */
export interface ModelPrice {
  in: number;
  out: number;
}

export interface Config {
  user: string;
  gatewayUrl: string;
  ollamaUrl: string;
  /** The default limit for every user. */
  budget: { limitUsd: number; period: 'day' | 'month' };
  /** Individual limits by user name, overriding the default. Set with: frugal budget set <usd> --user <name> */
  userBudgets: Record<string, { limitUsd: number; period: 'day' | 'month' }>;
  /** Ordered chains: the first entry is tried first, the rest are fallbacks. */
  models: { fast: string[]; strong: string[]; local: string };
  /**
   * The Ollama model the local variant is built from, and the context window to give it.
   * Ollama defaults to 4096 tokens, which a coding session outgrows within a few steps.
   */
  localBase: string;
  localContextTokens: number;
  /** Keyed by model-name prefix; the longest matching prefix wins. */
  prices: Record<string, ModelPrice>;
  /** The current user's gateway keys (an entry of `userKeys`). */
  virtualKeys: { cloud: string; local: string };
  /** Bifrost virtual keys per user: one that may reach cloud providers, one that may reach only Ollama. */
  userKeys: Record<string, { cloud: string; local: string }>;
  maxOutputTokens: number;
  /** Conversation size at which old tool output is compacted. */
  contextBudgetTokens: number;
}

/** All agent state lives here, outside any repository, so repo content can never edit it. */
export const HOME = process.env.FRUGAL_HOME || path.join(os.homedir(), '.frugal');
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(HOME, 'config.json');

export const PROVIDER_KEY_ENV: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const newVirtualKey = () => `sk-bf-${crypto.randomBytes(18).toString('hex')}`;

function defaults(): Config {
  return {
    user: os.userInfo().username,
    gatewayUrl: 'http://127.0.0.1:8080',
    ollamaUrl: 'http://127.0.0.1:11434',
    budget: { limitUsd: 0.5, period: 'day' },
    userBudgets: {},
    models: {
      // Checked against the live gateway on 2026-11-10: each of these answered with a valid tool call.
      // Gemini leads both chains: Groq's free tier refuses any single request over 8,000 tokens,
      // which a coding session passes within a few steps, so Groq serves as the fallback.
      fast: ['gemini/gemini-3.5-flash-lite', 'groq/openai/gpt-oss-20b', 'groq/qwen/qwen3.8-27b'],
      strong: ['gemini/gemini-3.5-flash', 'groq/openai/gpt-oss-120b', 'gemini/gemini-3.8-flash'],
      local: `ollama/${localVariantOf('qwen2.5-coder:3b')}`,
    },
    localBase: 'qwen2.5-coder:3b',
    localContextTokens: 8192,
    // List prices, used to meter spend even on free tiers so the budget is meaningful.
    prices: {
      'ollama/': { in: 0, out: 0 },
      // Approximate: adjust in ~/.frugal/config.json to match each provider's current price page.
      'groq/': { in: 0.3, out: 0.6 },
      'groq/openai/gpt-oss-20b': { in: 0.075, out: 0.3 },
      'groq/openai/gpt-oss-120b': { in: 0.15, out: 0.6 },
      'cerebras/': { in: 0.85, out: 1.2 },
      'gemini/': { in: 0.3, out: 2.5 },
      'gemini/gemini-3.5-flash-lite': { in: 0.1, out: 0.4 },
      'openrouter/': { in: 0.3, out: 1.2 },
      '': { in: 0.5, out: 1.5 },
    },
    virtualKeys: { cloud: '', local: '' },
    userKeys: {},
    maxOutputTokens: 2048,
    contextBudgetTokens: 12000,
  };
}

/**
 * Load API keys from the agent's own .env files only. The working repository's .env is never
 * read: it is untrusted input and may belong to a confidential project.
 */
export function loadEnv(): void {
  for (const file of [path.join(HOME, '.env'), path.join(PACKAGE_ROOT, '.env')]) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith('#')) continue;
      const value = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
      if (value && process.env[m[1]!] === undefined) process.env[m[1]!] = value;
    }
  }
}

export function loadConfig(): Config {
  const base = defaults();
  const stored = readJson<Partial<Config>>(CONFIG_FILE, {});
  const cfg: Config = {
    ...base,
    ...stored,
    budget: { ...base.budget, ...stored.budget },
    models: { ...base.models, ...stored.models },
    prices: { ...base.prices, ...stored.prices },
    userKeys: { ...stored.userKeys },
  };
  // Installs from before per-user keys kept a single pair: it belongs to the machine's user.
  if (stored.virtualKeys && !cfg.userKeys[base.user]) cfg.userKeys[base.user] = stored.virtualKeys;
  setUser(cfg, cfg.user);
  return cfg;
}

/**
 * Switch the config to a user, creating their gateway keys on first sight. Each user gets their
 * own pair of Bifrost virtual keys, so the gateway tracks and limits each person separately.
 * Only the keys are written to disk; everything else stays with the built-in defaults.
 */
export function setUser(cfg: Config, user: string): void {
  cfg.user = user;
  if (!cfg.userKeys[user]) {
    cfg.userKeys[user] = { cloud: newVirtualKey(), local: newVirtualKey() };
    updateStoredConfig({ userKeys: { ...readJson<Partial<Config>>(CONFIG_FILE, {}).userKeys, ...cfg.userKeys } });
  }
  cfg.virtualKeys = cfg.userKeys[user]!;
}

/** Persist only the given settings, leaving everything else to the defaults. */
export function updateStoredConfig(patch: Partial<Config>): void {
  writeJsonAtomic(CONFIG_FILE, { ...readJson<Partial<Config>>(CONFIG_FILE, {}), ...patch });
}

/** Name of the local model variant we create with a larger context window. */
/** Carries an explicit tag: Bifrost matches model names exactly as Ollama lists them. */
export const localVariantOf = (base: string) => `frugal-${base.replace(/[:/]/g, '-')}:latest`;

/** The spending limit that applies to the current user. */
export function budgetOf(cfg: Config): { limitUsd: number; period: 'day' | 'month' } {
  return cfg.userBudgets[cfg.user] ?? cfg.budget;
}

export const providerOf = (model: string) => model.split('/')[0]!;
export const isLocalModel = (model: string) => providerOf(model) === 'ollama';

/**
 * Names of the environment variables holding keys for a provider: the base name, plus any
 * suffixed variants (GEMINI_API_KEY_2, GROQ_API_KEY_work). Several keys are load-balanced.
 */
export function providerKeyEnvs(provider: string, opts: { includeDead?: boolean } = {}): string[] {
  const base = PROVIDER_KEY_ENV[provider];
  if (!base) return [];
  const re = new RegExp(`^${base}(_\\w+)?$`);
  const dead = opts.includeDead ? {} : loadDeadKeys();
  const seen = new Set<string>();
  return Object.keys(process.env)
    .filter((name) => re.test(name) && !!process.env[name])
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .filter((name) => {
      // The same key pasted under two names counts once; keys that failed `frugal keys` are left out.
      const value = process.env[name]!;
      if (seen.has(value) || dead[name] === fingerprint(value)) return false;
      seen.add(value);
      return true;
    });
}

/**
 * Keys that failed the last `frugal keys` check, by variable name. Each entry stores a hash of
 * the key it was tested with, so replacing a dead key with a new one revives the slot.
 */
export const DEAD_KEYS_FILE = path.join(HOME, 'dead-keys.json');
export const fingerprint = (key: string) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
export const loadDeadKeys = () => readJson<Record<string, string>>(DEAD_KEYS_FILE, {});

/** Every environment variable that holds one of the agent's own secrets. */
export function secretEnvNames(): string[] {
  return [...Object.keys(PROVIDER_KEY_ENV).flatMap((p) => providerKeyEnvs(p, { includeDead: true })), 'TAVILY_API_KEY'];
}

/** Providers that have an API key configured in this environment. */
export function configuredProviders(): string[] {
  return Object.keys(PROVIDER_KEY_ENV).filter((provider) => providerKeyEnvs(provider).length > 0);
}

/** Drop chain entries whose provider has no key, so we never spend a round trip on a sure failure. */
export function usableChain(chain: string[]): string[] {
  const have = new Set(configuredProviders());
  return chain.filter((m) => isLocalModel(m) || have.has(providerOf(m)));
}

export function priceOf(cfg: Config, model: string): ModelPrice {
  let best = '';
  for (const prefix of Object.keys(cfg.prices)) {
    if (model.startsWith(prefix) && prefix.length >= best.length) best = prefix;
  }
  return cfg.prices[best] ?? { in: 0.5, out: 1.5 };
}

export function costOf(cfg: Config, model: string, tokensIn: number, tokensOut: number): number {
  const p = priceOf(cfg, model);
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}
