import { DEAD_KEYS_FILE, PROVIDER_KEY_ENV, fingerprint, providerKeyEnvs } from '../config.ts';
import { writeJsonAtomic } from '../util.ts';

export interface KeyCheck {
  provider: string;
  env: string;
  ok: boolean;
  /** Why the key was rejected, or a note such as "rate limited (key is valid)". */
  detail: string;
}

/** A request that proves a key is usable while spending no tokens (or one, where listing is not enough). */
const PROBES: Record<string, (key: string) => Promise<Response>> = {
  groq: (key) => fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }),
  gemini: (key) => fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000) }),
  // Cerebras lists models for accounts that cannot use them (no billing), so its probe is a
  // one-token completion instead.
  cerebras: (key) =>
    fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15_000),
    }),
  nvidia: (key) => fetch('https://integrate.api.nvidia.com/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }),
  openrouter: (key) => fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }),
};

async function checkOne(provider: string, env: string): Promise<KeyCheck> {
  try {
    const res = await PROBES[provider]!(process.env[env]!);
    if (res.ok) return { provider, env, ok: true, detail: 'working' };
    // A rate-limited key is a valid key; only an authentication failure makes it dead.
    if (res.status === 429) return { provider, env, ok: true, detail: 'working (rate limited right now)' };
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message += `: ${body.error.message.split('\n')[0]!.slice(0, 90)}`;
    } catch {
      /* no JSON body */
    }
    // Only a clear rejection of the key itself removes it; a provider outage must not empty the pool.
    // 402 means the account has no free quota: the key is real but useless on a zero budget.
    const rejected = res.status === 400 || res.status === 401 || res.status === 402 || res.status === 403;
    return { provider, env, ok: !rejected, detail: rejected ? message : `unclear (${message}), kept` };
  } catch (err) {
    return { provider, env, ok: true, detail: `could not reach provider (${(err as Error).message}), kept` };
  }
}

/**
 * Test every configured key against its provider and record the dead ones, so they are left out
 * of the gateway's pool. Returns one result per key, including duplicates of the same key.
 */
export async function checkKeys(): Promise<KeyCheck[]> {
  const jobs: Promise<KeyCheck>[] = [];
  const seen = new Map<string, string>();
  const duplicates: KeyCheck[] = [];
  for (const provider of Object.keys(PROVIDER_KEY_ENV)) {
    for (const env of allKeyEnvs(provider)) {
      const value = process.env[env]!;
      const first = seen.get(value);
      if (first) duplicates.push({ provider, env, ok: false, detail: `same key as ${first}, counted once` });
      else {
        seen.set(value, env);
        jobs.push(checkOne(provider, env));
      }
    }
  }
  const results = await Promise.all(jobs);
  const dead: Record<string, string> = {};
  for (const r of results) if (!r.ok) dead[r.env] = fingerprint(process.env[r.env]!);
  writeJsonAtomic(DEAD_KEYS_FILE, dead);
  return [...results, ...duplicates].sort((a, b) => a.provider.localeCompare(b.provider) || a.env.localeCompare(b.env, undefined, { numeric: true }));
}

/** Every key variable for a provider, including dead and duplicate ones. */
function allKeyEnvs(provider: string): string[] {
  const re = new RegExp(`^${PROVIDER_KEY_ENV[provider]}(_\\w+)?$`);
  return Object.keys(process.env)
    .filter((name) => re.test(name) && !!process.env[name])
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export { providerKeyEnvs };
