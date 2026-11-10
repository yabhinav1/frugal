import { Budget, BudgetExceededError } from '../budget.ts';
import { costOf, isLocalModel, usableChain, type Config } from '../config.ts';
import type { Policy } from '../policy.ts';
import type { Frontend, Message, Stats, Tier, ToolSpec } from '../types.ts';
import { estimateTokens, isLoopbackUrl, sleep } from '../util.ts';

export class ModelError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = retryable;
  }
}

interface RawResponse {
  choices?: { message?: Message; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  model?: string;
  extra_fields?: {
    provider?: string;
    routing_info?: { provider?: string; model?: string; is_fallback?: boolean; primary_provider?: string; primary_model?: string };
  };
  error?: { message?: string };
  type?: string;
}

export interface Completion {
  message: Message;
  /** provider/model that actually answered. */
  model: string;
  truncated: boolean;
}

/**
 * Every model call in the agent goes through here. The order of operations is the contract:
 *
 *   1. privacy   - in a local-only session the candidate list is rebuilt from the local model
 *                  alone, the request carries the gateway key that can only reach Ollama, and the
 *                  call is refused outright if anything else slipped in;
 *   2. budget    - the worst-case cost of the call is checked against the user's ledger before
 *                  any bytes leave the process;
 *   3. send      - through Bifrost, which handles provider failover;
 *   4. survive   - if Bifrost itself is unreachable or every provider failed, continue on the
 *                  local model directly so the session is not lost;
 *   5. account   - record real usage, and tell the user whenever the answering model changed.
 */
export class Router {
  private cfg: Config;
  private policy: Policy;
  private budget: Budget;
  private frontend: Frontend;
  private stats: Stats;
  private lastModel: string | null = null;
  /** Set when the user chooses to continue on the free local model after hitting their limit. */
  private userLocalOnly = false;
  /** True while calls are going straight to Ollama because the gateway route is failing. */
  private bypassing = false;

  constructor(cfg: Config, policy: Policy, budget: Budget, frontend: Frontend, stats: Stats) {
    this.cfg = cfg;
    this.policy = policy;
    this.budget = budget;
    this.frontend = frontend;
    this.stats = stats;
    if (policy.confidential && !isLoopbackUrl(cfg.ollamaUrl)) {
      throw new Error(`Confidential repository, but the local model URL (${cfg.ollamaUrl}) is not on this machine. Refusing to start.`);
    }
  }

  get localOnly(): boolean {
    return this.policy.confidential || this.userLocalOnly;
  }

  setUserLocalOnly(value: boolean): void {
    this.userLocalOnly = value;
  }

  /**
   * Benchmark use only: never substitute another model. When the pinned model's provider is
   * overloaded, wait and ask again, so a measurement is not polluted by a different model.
   */
  pinned = false;

  /** The models this session may use for a tier, in order of preference. */
  chain(tier: Tier): string[] {
    if (this.localOnly || tier === 'local') return [this.cfg.models.local];
    const cloud = usableChain(this.cfg.models[tier]);
    if (this.pinned && cloud.length) return cloud;
    // The local model closes every chain: a total cloud outage degrades the session, not ends it.
    return [...cloud, this.cfg.models.local];
  }

  /**
   * @param onText when given, the reply is streamed and each piece of text is passed here as it
   *   arrives. The returned completion is the same either way.
   */
  async complete(messages: Message[], tools: ToolSpec[], tier: Tier, signal?: AbortSignal, onText?: (delta: string) => void): Promise<Completion> {
    const chain = this.chain(tier);

    // 1. Privacy. Checked here, in code, on the final candidate list.
    if (this.localOnly && !chain.every(isLocalModel)) {
      throw new Error('Internal policy violation: non-local model in a local-only session. Call blocked.');
    }

    // 2. Budget. Worst case: the priciest model in the chain, with a full-length reply.
    const tokensIn = estimateTokens(JSON.stringify(messages)) + estimateTokens(JSON.stringify(tools));
    // A small local model gains nothing from a long reply, and a runaway one wastes minutes.
    const maxOut = chain.every(isLocalModel) ? Math.min(1024, this.cfg.maxOutputTokens) : this.cfg.maxOutputTokens;
    const estimate = Math.max(...chain.map((m) => costOf(this.cfg, m, tokensIn, maxOut)));
    this.budget.assertCanSpend(estimate);

    const body = { messages, tools: tools.length ? tools : undefined, max_tokens: maxOut, temperature: 0 };

    // 3 + 4. Send, and survive failure.
    let raw: RawResponse;
    let viaGateway = true;
    try {
      raw = await this.viaGateway(chain, body, signal, onText);
      if (this.bypassing) {
        this.bypassing = false;
        this.frontend.emit({ type: 'notice', level: 'info', text: 'The gateway is answering again.' });
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof BudgetExceededError) throw err;
      if (!(err instanceof ModelError)) throw err;
      // A gateway that has not yet catalogued the local model refuses it (403/404). Going to
      // Ollama directly is still inside the privacy policy, so that case is survivable too.
      const localRefused = (err.status === 403 || err.status === 404) && chain.every(isLocalModel);
      if (!err.retryable && !localRefused) throw err;
      if (this.pinned && !chain.every(isLocalModel)) {
        // Pinned: outlast the outage instead of switching models. Up to about three minutes.
        let answered: RawResponse | null = null;
        for (let wait = 1; wait <= 9 && !answered; wait++) {
          await sleep(20_000);
          if (signal?.aborted) throw err;
          try {
            answered = await this.viaGateway(chain, body, signal);
          } catch (again) {
            if (!(again instanceof ModelError) || !again.retryable) throw again;
          }
        }
        if (!answered) throw err;
        raw = answered;
      } else {
        // Say it once per outage, not on every call.
        if (!this.bypassing) this.frontend.emit({ type: 'notice', level: 'warn', text: `Gateway route failed (${err.message}). Continuing on the local model so the session is not lost.` });
        this.bypassing = true;
        raw = await this.directLocal(body, signal);
        viaGateway = false;
      }
    }

    const message = raw.choices?.[0]?.message;
    if (!message) throw new ModelError(`Empty response from model${raw.error?.message ? `: ${raw.error.message}` : ''}`, 502, true);
    // Some providers return content as a list of parts rather than a string. Flatten it once
    // here so the rest of the agent only ever sees text.
    const content: unknown = message.content;
    if (Array.isArray(content)) {
      message.content = content.map((part) => (typeof part === 'string' ? part : ((part as { text?: string })?.text ?? ''))).join('');
    } else if (content != null && typeof content !== 'string') {
      message.content = (content as { text?: string }).text ?? JSON.stringify(content);
    }

    const info = raw.extra_fields?.routing_info;
    const provider = viaGateway ? (info?.provider ?? raw.extra_fields?.provider ?? chain[0]!.split('/')[0]!) : 'ollama';
    const served = `${provider}/${info?.model ?? raw.model ?? chain[0]!.split('/').slice(1).join('/')}`;

    // Defence in depth: a cloud answer in a local-only session is discarded, never shown or stored.
    if (this.localOnly && !isLocalModel(served)) {
      throw new Error(`Policy violation: ${served} answered a local-only session. Response discarded.`);
    }

    // 5. Account.
    const inTok = raw.usage?.prompt_tokens ?? tokensIn;
    const outTok = raw.usage?.completion_tokens ?? estimateTokens(JSON.stringify(message));
    const cost = costOf(this.cfg, served, inTok, outTok);
    const s = this.stats;
    s.calls++;
    s.tokensIn += inTok;
    s.tokensOut += outTok;
    s.cachedTokens += raw.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    s.costUsd += cost;
    const per = (s.byModel[served] ??= { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
    per.calls++;
    per.tokensIn += inTok;
    per.tokensOut += outTok;
    per.costUsd += cost;
    const status = this.budget.record(cost, inTok, outTok);

    if (served !== this.lastModel) {
      const failedOver = !viaGateway || info?.is_fallback === true;
      if (failedOver) s.failovers++;
      const reason = !viaGateway
        ? 'the gateway route failed, using the local model directly'
        : info?.is_fallback
          ? `${info.primary_provider}/${info.primary_model} was unavailable, failed over`
          : this.lastModel === null
            ? 'session start'
            : 'routing changed';
      this.frontend.emit({ type: 'model', model: served, previous: this.lastModel, reason, failedOver });
      this.lastModel = served;
    }
    this.frontend.emit({ type: 'usage', stats: s, model: served });
    this.frontend.emit({ type: 'budget', status });

    return { message, model: served, truncated: raw.choices?.[0]?.finish_reason === 'length' };
  }

  private async viaGateway(chain: string[], body: object, signal?: AbortSignal, onText?: (delta: string) => void): Promise<RawResponse> {
    // A confidential session must not send code to a gateway on another machine either.
    if (this.localOnly && !isLoopbackUrl(this.cfg.gatewayUrl)) {
      throw new ModelError('gateway is remote and this session is local-only', 0, true);
    }
    const vk = this.localOnly ? this.cfg.virtualKeys.local : this.cfg.virtualKeys.cloud;
    const payload = JSON.stringify({ ...body, model: chain[0], fallbacks: chain.slice(1), ...(onText ? { stream: true, stream_options: { include_usage: true } } : {}) });

    let last: ModelError | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(700 * attempt);
      let res: Response;
      try {
        res = await fetch(`${this.cfg.gatewayUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-bf-vk': vk },
          body: payload,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        last = new ModelError('gateway unreachable', 0, true);
        continue;
      }
      if (res.ok && onText && res.body && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        try {
          return await readStream(res.body, onText);
        } catch (err) {
          if (signal?.aborted || !(err instanceof ModelError)) throw err;
          last = err;
          continue;
        }
      }
      const text = await res.text();
      let json: RawResponse = {};
      try {
        json = JSON.parse(text) as RawResponse;
      } catch {
        /* non-JSON error body */
      }
      if (res.ok) return json;

      const msg = json.error?.message ?? text.slice(0, 200);
      if (res.status === 402 || json.type === 'budget_exceeded') {
        // The gateway's own budget for this user's key tripped: same outcome as our ledger check.
        throw new BudgetExceededError(this.budget.status(), 0);
      }
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      const hint = res.status === 401 ? ' The gateway does not know this user\'s key: stop it and run "frugal gateway" to reload its config.' : '';
      last = new ModelError(`HTTP ${res.status}: ${msg}${hint}`, res.status, retryable);
      if (!retryable) throw last;
    }
    throw last ?? new ModelError('gateway failed', 0, true);
  }

  /** Last resort: talk to Ollama on this machine without the gateway. Always within policy. */
  private async directLocal(body: object, signal?: AbortSignal): Promise<RawResponse> {
    if (!isLoopbackUrl(this.cfg.ollamaUrl) && this.localOnly) {
      throw new ModelError('local model is not on this machine', 0, false);
    }
    const model = this.cfg.models.local.replace(/^ollama\//, '');
    let res: Response;
    try {
      res = await fetch(`${this.cfg.ollamaUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, model }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ModelError('No model reachable: the gateway failed and Ollama is not running on this machine.', 0, false);
    }
    if (!res.ok) throw new ModelError(`Local model error HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status, false);
    return (await res.json()) as RawResponse;
  }
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: RawResponse['usage'] | null;
  model?: string;
  extra_fields?: RawResponse['extra_fields'];
  error?: { message?: string };
}

/**
 * Read a server-sent-event stream of chat completion chunks and assemble the same shape a
 * non-streamed call returns. Text is handed to `onText` as it arrives; tool calls arrive in
 * fragments and are joined by index.
 */
export async function readStream(body: ReadableStream<Uint8Array>, onText: (delta: string) => void): Promise<RawResponse> {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finish: string | undefined;
  const calls: NonNullable<Message['tool_calls']> = [];
  const out: RawResponse = {};

  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      return; // a partial or non-JSON keep-alive line
    }
    if (chunk.error) throw new ModelError(`stream error: ${chunk.error.message ?? 'unknown'}`, 502, true);
    if (chunk.usage) out.usage = chunk.usage;
    if (chunk.model) out.model = chunk.model;
    if (chunk.extra_fields?.routing_info?.provider || chunk.extra_fields?.provider) out.extra_fields = chunk.extra_fields;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      content += delta.content;
      onText(delta.content);
    }
    for (const part of delta?.tool_calls ?? []) {
      const call = (calls[part.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (part.id) call.id = part.id;
      if (part.function?.name && !call.function.name) call.function.name = part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
  };

  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl).trimEnd());
      buffer = buffer.slice(nl + 1);
    }
  }
  handle(buffer.trim());

  const toolCalls = calls.filter(Boolean);
  out.choices = [{ message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }];
  return out;
}

export function emptyStats(): Stats {
  return { calls: 0, tokensIn: 0, tokensOut: 0, cachedTokens: 0, costUsd: 0, toolCalls: 0, tokensSaved: 0, failovers: 0, byModel: {} };
}
