import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Message } from './types.ts';
import { estimateTokens } from './util.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.cache', 'vendor', '.idea', '.vscode', '.frugal']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|svgz|pdf|zip|gz|tar|7z|rar|exe|dll|so|dylib|bin|woff2?|ttf|eot|mp[34]|mov|avi|wasm|class|jar|pyc|lock|db|sqlite)$/i;
const MAX_FILE_BYTES = 512 * 1024;

/** Top-level .gitignore entries, as simple name and extension rules. Enough to skip generated output. */
function gitignoreRules(root: string): { names: Set<string>; exts: Set<string> } {
  const names = new Set<string>();
  const exts = new Set<string>();
  try {
    for (const raw of fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/)) {
      const line = raw.trim().replace(/^\/|\/$/g, '');
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      if (/^\*\.[\w.]+$/.test(line)) exts.add(line.slice(1).toLowerCase());
      else if (!/[*?[\]/]/.test(line)) names.add(line);
    }
  } catch {
    /* no .gitignore */
  }
  return { names, exts };
}

/** Repo-relative paths of text source files, shallowest first. */
export function listFiles(root: string, sub = '.', limit = 5000): string[] {
  const rules = gitignoreRules(root);
  const out: string[] = [];
  const queue = [path.resolve(root, sub)];
  while (queue.length && out.length < limit) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (rules.names.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
      } else if (e.isFile() && !BINARY.test(e.name) && !rules.exts.has(path.extname(e.name).toLowerCase())) {
        out.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

const SYMBOL_PATTERNS: [RegExp, RegExp][] = [
  [/\.(m?[jt]sx?|cjs)$/, /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)|^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/],
  [/\.py$/, /^(?:async\s+)?(?:def|class)\s+(\w+)/],
  [/\.go$/, /^func\s+(?:\([^)]*\)\s*)?(\w+)|^type\s+(\w+)/],
  [/\.rs$/, /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod)\s+(\w+)/],
  [/\.(java|kt|cs|scala)$/, /^\s{0,4}(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open)\s+)*(?:class|interface|enum|record|object)\s+(\w+)/],
  [/\.(rb)$/, /^\s{0,2}(?:def|class|module)\s+([\w.?!]+)/],
  [/\.(c|h|cc|cpp|hpp)$/, /^[A-Za-z_][\w\s*:<>,]*?\b([A-Za-z_]\w*)\s*\([^;]*$/],
];

/** Top-level symbols with their line numbers, found by pattern. No parser, no tokens spent. */
export function symbolsOf(rel: string, text: string): string[] {
  const pattern = SYMBOL_PATTERNS.find(([ext]) => ext.test(rel))?.[1];
  if (!pattern) return [];
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < 40; i++) {
    const m = pattern.exec(lines[i]!);
    const name = m && m.slice(1).find(Boolean);
    if (name) out.push(`${name}@${i + 1}`);
  }
  return out;
}

/**
 * A compact index of the repository: every file, and for source files the top-level symbols with
 * line numbers. It lets the model jump to `src/x.ts` lines 40-80 instead of reading whole files
 * to find out what is in them. Built once per session and placed in the stable prompt prefix, so
 * providers that cache prompt prefixes charge for it once.
 */
export function buildRepoMap(root: string, tokenBudget: number, sub = '.'): string {
  const files = listFiles(root, sub);
  const lines: string[] = [];
  let used = 0;
  let listed = 0;
  let symbolsOn = true;
  for (const rel of files) {
    let line = rel;
    if (symbolsOn) {
      try {
        const stat = fs.statSync(path.join(root, rel));
        if (stat.size <= MAX_FILE_BYTES) {
          const syms = symbolsOf(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
          if (syms.length) line = `${rel}: ${syms.join(' ')}`;
        }
      } catch {
        /* unreadable: list the name only */
      }
    }
    const cost = estimateTokens(line) + 1;
    if (used + cost > tokenBudget) {
      // Past 70% of the budget, keep listing file names but stop spending on symbols.
      if (symbolsOn && line !== rel) {
        symbolsOn = false;
        line = rel;
        if (used + estimateTokens(rel) + 1 > tokenBudget) break;
      } else break;
    }
    if (used > tokenBudget * 0.7) symbolsOn = false;
    lines.push(line);
    used += estimateTokens(line) + 1;
    listed++;
  }
  if (listed < files.length) lines.push(`(+${files.length - listed} more files; use map with a path to list a subdirectory)`);
  return lines.join('\n');
}

/**
 * Remembers which file ranges are already in the conversation. A repeat read of an unchanged
 * range returns a one-line pointer instead of the content: the single most common waste in
 * coding agents, removed without a model call.
 */
export class FileMemory {
  private seen = new Map<string, { hash: string; ranges: { start: number; end: number; callId: string }[] }>();

  static hash(text: string): string {
    return crypto.createHash('sha1').update(text).digest('hex');
  }

  /** The earlier read that already covers this range of this exact file content, if any. */
  covered(rel: string, hash: string, start: number, end: number): { start: number; end: number } | null {
    const entry = this.seen.get(rel);
    if (!entry || entry.hash !== hash) return null;
    return entry.ranges.find((r) => r.start <= start && r.end >= end) ?? null;
  }

  remember(rel: string, hash: string, start: number, end: number, callId: string): void {
    const entry = this.seen.get(rel);
    if (!entry || entry.hash !== hash) this.seen.set(rel, { hash, ranges: [{ start, end, callId }] });
    else entry.ranges.push({ start, end, callId });
  }

  /** Called when a tool result is compacted away: that content is no longer in context. */
  forgetCall(callId: string): void {
    for (const [rel, entry] of this.seen) {
      entry.ranges = entry.ranges.filter((r) => r.callId !== callId);
      if (!entry.ranges.length) this.seen.delete(rel);
    }
  }

  clear(): void {
    this.seen.clear();
  }
}

/**
 * When a command is run again, the output of its earlier runs is out of date: the newer result
 * is the truth. Replace the older outputs with a one-line stub so they stop being resent.
 * Returns the number of tokens removed.
 */
export function supersedeCommandOutputs(messages: Message[], cmd: string, latestCallId: string): number {
  const earlier = new Set<string>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      if (call.id === latestCallId || call.function.name !== 'sh') continue;
      try {
        if (String((JSON.parse(call.function.arguments) as { cmd?: unknown }).cmd ?? '').trim() === cmd) earlier.add(call.id);
      } catch {
        /* unparseable arguments: not a match */
      }
    }
  }
  let saved = 0;
  for (const m of messages) {
    if (m.role !== 'tool' || !m.tool_call_id || !earlier.has(m.tool_call_id) || !m.content || m.content.startsWith('[')) continue;
    const before = estimateTokens(m.content);
    if (before <= 40) continue;
    m.content = `[${m.content.split('\n', 1)[0]}; output replaced by the later run of this command below]`;
    saved += before - estimateTokens(m.content);
  }
  return saved;
}

const MENTION = /(?:^|[\s"'`(])((?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z]{1,5})(?=$|[\s"'`),.:;!?])/g;
const IMPORT = /(?:from\s+|require\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * Files the user's message points at, plus the local files those import. Reading is free under
 * the approval rules, so the agent can hand these to the model up front instead of paying a
 * model round trip for each one. Paths are returned repo-relative; the caller enforces policy.
 */
export function mentionedFiles(root: string, text: string, maxFiles = 5): string[] {
  const found: string[] = [];
  const add = (abs: string) => {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (rel.startsWith('..') || path.isAbsolute(rel) || found.includes(rel) || found.length >= maxFiles) return;
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= 24 * 1024 && !BINARY.test(abs)) found.push(rel);
    } catch {
      /* not a file in this repo */
    }
  };
  for (const m of text.matchAll(MENTION)) add(path.resolve(root, m[1]!));
  // One level of imports from the mentioned files: a failing test names the code under test.
  for (const rel of [...found]) {
    let source: string;
    try {
      source = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of source.matchAll(IMPORT)) {
      const base = path.resolve(root, path.dirname(rel), m[1]!);
      const hit = [base, `${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}.py`].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (hit) add(hit);
    }
  }
  return found;
}

export function conversationTokens(messages: Message[]): number {
  let n = 0;
  for (const m of messages) n += estimateTokens(m.content ?? '') + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0) + 4;
  return n;
}

/**
 * Shrink the conversation without a model call. Oldest tool results are replaced by a one-line
 * stub until the conversation fits the budget; the most recent results are always kept intact.
 * Returns the number of tokens removed.
 */
export function compact(messages: Message[], budgetTokens: number, memory: FileMemory, keepRecent = 4): number {
  let total = conversationTokens(messages);
  if (total <= budgetTokens) return 0;
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  let saved = 0;
  for (const i of candidates) {
    if (total <= budgetTokens) break;
    const m = messages[i]!;
    const before = estimateTokens(m.content ?? '');
    if (before <= 40 || m.content?.startsWith('[elided')) continue;
    const firstLine = (m.content ?? '').split('\n', 1)[0]!.slice(0, 100);
    m.content = `[elided to save tokens; re-run the tool if you need it again] ${firstLine}`;
    if (m.tool_call_id) memory.forgetCall(m.tool_call_id);
    const delta = before - estimateTokens(m.content);
    saved += delta;
    total -= delta;
  }
  return saved;
}
