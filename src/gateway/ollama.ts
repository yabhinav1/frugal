import type { Config } from '../config.ts';

export type LocalModelState = 'ready' | 'created' | 'no-ollama' | 'no-base';

/**
 * Make sure the local model variant exists. It is the base model plus a larger context window;
 * Ollama stores it as a small manifest that shares the base model's weights, so it costs no disk.
 */
export async function ensureLocalModel(cfg: Config): Promise<LocalModelState> {
  const want = cfg.models.local.replace(/^ollama\//, '');
  let tags: string[];
  try {
    const res = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    tags = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch {
    return 'no-ollama';
  }
  const has = (name: string) => tags.includes(name) || tags.includes(`${name}:latest`) || tags.includes(name.replace(/:latest$/, ''));
  if (has(want)) return 'ready';
  if (!has(cfg.localBase)) return 'no-base';
  const res = await fetch(`${cfg.ollamaUrl}/api/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: want, from: cfg.localBase, parameters: { num_ctx: cfg.localContextTokens }, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  return res.ok ? 'created' : 'no-base';
}
