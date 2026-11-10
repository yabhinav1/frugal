import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACHED_MARK, Agent } from '../agent.ts';
import type { PreApprovals } from '../approval.ts';
import { HOME, type Config } from '../config.ts';
import type { Policy } from '../policy.ts';
import type { Session } from '../session.ts';
import { ToolBox } from '../tools.ts';
import type { AgentEvent, ApprovalDecision, ApprovalRequest, BudgetChoice, BudgetStatus, Frontend, Tier } from '../types.ts';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ASSETS: Record<string, string> = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/app.css': 'app.css',
};
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/**
 * Browser front end. It implements the same Frontend contract as the terminal: events are pushed
 * to the page over server-sent events, and approvals wait for a POST from the page. Because the
 * page can approve shell commands, the server is locked down: loopback only, a random access
 * token, and Host/Origin checks so no other website can talk to it.
 */
class WebFrontend implements Frontend {
  private seq = 0;
  private clients = new Set<http.ServerResponse>();
  pendingApproval: { request: ApprovalRequest; resolve: (d: ApprovalDecision) => void } | null = null;
  pendingBudget: { status: BudgetStatus; estimateUsd: number; resolve: (c: BudgetChoice) => void } | null = null;

  get lastSeq(): number {
    return this.seq;
  }

  emit(event: AgentEvent): void {
    const frame = `id: ${++this.seq}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  subscribe(res: http.ServerResponse): void {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => (this.pendingApproval = { request, resolve }));
  }

  budgetLimit(status: BudgetStatus, estimateUsd: number): Promise<BudgetChoice> {
    return new Promise((resolve) => (this.pendingBudget = { status, estimateUsd, resolve }));
  }
}

/**
 * The access token for the local web UI. It is created once and kept in the user's home
 * directory (outside any repo), so a browser that has signed in stays signed in when the server
 * restarts. Delete the file to revoke every existing sign-in.
 */
function webToken(): string {
  const file = path.join(HOME, 'web-token');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{48}$/.test(saved)) return saved;
  } catch {
    /* first run */
  }
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}

export interface WebOptions {
  cfg: Config;
  policy: Policy;
  session: Session;
  port: number;
  pre: PreApprovals;
  forceTier?: Tier;
}

export async function startWebServer(o: WebOptions): Promise<{ url: string; close: () => void }> {
  const token = webToken();
  const frontend = new WebFrontend();
  const agent = new Agent({ cfg: o.cfg, policy: o.policy, session: o.session, frontend, pre: o.pre, forceTier: o.forceTier });
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk;
        if (data.length > 1_000_000) reject(new Error('Body too large'));
      });
      req.on('end', () => {
        try {
          resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
    });

  const authed = (req: http.IncomingMessage) => {
    const cookie = /(?:^|;\s*)frugal=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    return cookie.length === token.length && crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(token));
  };

  /** What the page needs to draw itself from scratch, including after a reload mid-turn. */
  const state = () => ({
    session: { id: o.session.id, title: o.session.title },
    repo: path.basename(o.policy.root),
    root: o.policy.root,
    confidential: o.policy.confidential,
    confidentialSources: o.policy.sources,
    user: o.cfg.user,
    chain: agent.router.chain(o.session.tier),
    localOnly: agent.router.localOnly,
    budget: agent.budget.status(),
    stats: o.session.stats,
    busy: agent.busy,
    seq: frontend.lastSeq,
    history: historyOf(o.session),
    pendingApproval: frontend.pendingApproval?.request ?? null,
    pendingBudget: frontend.pendingBudget ? { status: frontend.pendingBudget.status, estimateUsd: frontend.pendingBudget.estimateUsd } : null,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${o.port}`);

      // DNS-rebinding guard: only answer when addressed by a loopback name.
      if (!allowedHosts.has(req.headers.host ?? '')) return json(res, 403, { error: 'Forbidden host' });
      // Cross-site guard: a browser request from another origin is refused.
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'Forbidden origin' });

      res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');

      // First visit with the token from the terminal: swap it for a cookie and drop it from the URL.
      if (url.pathname === '/' && url.searchParams.has('token')) {
        const given = url.searchParams.get('token') ?? '';
        if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return json(res, 401, { error: 'Bad token' });
        res.writeHead(302, { 'set-cookie': `frugal=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
        return res.end();
      }
      if (!authed(req)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Not authorised. Open the full link printed by "frugal web" in your terminal.');
      }

      if (req.method === 'GET' && ASSETS[url.pathname]) {
        const file = ASSETS[url.pathname]!;
        res.writeHead(200, { 'content-type': MIME[path.extname(file)]!, 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(path.join(PUBLIC, file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        frontend.subscribe(res);
        const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
        res.on('close', () => clearInterval(beat));
        return;
      }

      if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
      const body = await readBody(req);

      if (url.pathname === '/api/message') {
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: 'Empty message' });
        if (agent.busy) return json(res, 409, { error: 'The agent is still working on the previous message.' });
        void agent.runTurn(text);
        return json(res, 202, { ok: true });
      }
      if (url.pathname === '/api/approval') {
        const p = frontend.pendingApproval;
        if (!p || p.request.id !== body.id) return json(res, 409, { error: 'No such pending approval.' });
        frontend.pendingApproval = null;
        p.resolve({ allow: body.allow === true, remember: body.remember === true, note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/budget') {
        const p = frontend.pendingBudget;
        if (!p) return json(res, 409, { error: 'No budget decision is pending.' });
        const action = body.action;
        const choice: BudgetChoice | null =
          action === 'local' ? { action: 'local' } : action === 'stop' ? { action: 'stop' } : action === 'raise' && Number(body.limitUsd) > p.status.limitUsd ? { action: 'raise', limitUsd: Number(body.limitUsd) } : null;
        if (!choice) return json(res, 400, { error: 'Choose local, stop, or raise with a higher limit.' });
        frontend.pendingBudget = null;
        p.resolve(choice);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/stop') {
        agent.stop();
        // A stop while a question is open answers it with "no".
        frontend.pendingApproval?.resolve({ allow: false, note: 'Stopped by the user.' });
        frontend.pendingApproval = null;
        frontend.pendingBudget?.resolve({ action: 'stop' });
        frontend.pendingBudget = null;
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE' ? new Error(`Port ${o.port} is in use. Try: frugal web --port ${o.port + 1}`) : err));
    server.listen(o.port, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${o.port}/?token=${token}`, close: () => server.close() };
}

/** The saved conversation, reduced to what the page draws. */
function historyOf(session: Session): { kind: 'user' | 'assistant' | 'tool'; text: string; category?: string }[] {
  const out: { kind: 'user' | 'assistant' | 'tool'; text: string; category?: string }[] = [];
  for (const m of session.messages) {
    // Show what the person typed, not the files the agent attached to it or its own check prompts.
    if (m.role === 'user' && m.content && !m.content.startsWith('(automatic check)')) out.push({ kind: 'user', text: m.content.split(ATTACHED_MARK)[0]! });
    if (m.role === 'assistant') {
      if (m.content) out.push({ kind: 'assistant', text: m.content });
      for (const call of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        } catch {
          /* show the bare tool name */
        }
        out.push({ kind: 'tool', text: ToolBox.summarize(call.function.name, args), category: ToolBox.categoryOf(call.function.name, args) });
      }
    }
  }
  return out;
}
