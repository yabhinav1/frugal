import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.ts';
import { readJson, writeJsonAtomic } from './util.ts';

/**
 * Security policy for one repository, resolved once at session start and then frozen.
 *
 * The rule that makes this prompt-proof: nothing the model reads or writes during a session can
 * loosen it. A repo may mark itself confidential (tightening), and that mark is copied into a
 * registry in the user's home directory, where the agent's tools cannot write. Deleting the
 * marker file from the repo afterwards changes nothing. Only the `frugal repo unmark` command,
 * typed by a human at a terminal, removes it.
 */
export interface Policy {
  readonly root: string;
  readonly confidential: boolean;
  /** Why the repo is confidential, for display. */
  readonly sources: readonly string[];
}

const REGISTRY = path.join(HOME, 'repos.json');
/** Marker files a repository can carry. */
const MARKERS = ['.frugal/policy.json', '.frugal.json'];

interface Registry {
  confidential: Record<string, { markedAt: string; by: string }>;
}

const loadRegistry = () => readJson<Registry>(REGISTRY, { confidential: {} });

/** Registry keys are case-folded on Windows, where paths are case-insensitive. */
const keyOf = (root: string) => (process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root));

/** The enclosing git repository, or the directory itself when there is none. */
export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function markerSaysConfidential(root: string): string | null {
  for (const rel of MARKERS) {
    const data = readJson<{ confidential?: unknown } | null>(path.join(root, rel), null);
    if (data && data.confidential === true) return rel;
  }
  return null;
}

export function markConfidential(root: string, by: string): void {
  const reg = loadRegistry();
  reg.confidential[keyOf(root)] ??= { markedAt: new Date().toISOString(), by };
  writeJsonAtomic(REGISTRY, reg);
}

export function unmarkConfidential(root: string): boolean {
  const reg = loadRegistry();
  const had = keyOf(root) in reg.confidential;
  delete reg.confidential[keyOf(root)];
  writeJsonAtomic(REGISTRY, reg);
  return had;
}

export function resolvePolicy(cwd: string, opts: { forceConfidential?: boolean } = {}): Policy {
  // Canonical form, so later containment checks compare like with like.
  const root = fs.realpathSync(findRepoRoot(cwd));
  const sources: string[] = [];

  const marker = markerSaysConfidential(root);
  if (marker) {
    sources.push(`repo marker ${marker}`);
    markConfidential(root, `repo marker ${marker}`); // sticky: survives deletion of the marker
  }
  if (keyOf(root) in loadRegistry().confidential && !marker) sources.push('user registry');
  if (opts.forceConfidential) sources.push('--confidential flag');
  if (process.env.FRUGAL_CONFIDENTIAL === '1') sources.push('FRUGAL_CONFIDENTIAL=1');

  return Object.freeze({ root, confidential: sources.length > 0, sources: Object.freeze(sources) });
}

/**
 * Resolve a model-supplied path and confine it to the repository. Symlinks are resolved first,
 * so a link inside the repo cannot be used to reach files outside it.
 */
export function resolveInRepo(policy: Policy, p: string): string {
  const abs = path.resolve(policy.root, p);
  let real = abs;
  // Resolve the deepest existing ancestor, so new files are checked too.
  for (let probe = abs; ; probe = path.dirname(probe)) {
    if (fs.existsSync(probe)) {
      real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
      break;
    }
    if (path.dirname(probe) === probe) break;
  }
  const rootReal = fs.realpathSync(policy.root);
  const rel = path.relative(rootReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the repository: ${p}`);
  }
  return real;
}

/** Paths whose modification changes what the agent or git will do later. */
export function isProtectedPath(policy: Policy, abs: string): boolean {
  const rel = path.relative(policy.root, abs).replace(/\\/g, '/').toLowerCase();
  return rel === '.frugal.json' || rel.startsWith('.frugal/') || rel.startsWith('.git/') || rel === '.git';
}

/** Files that commonly hold credentials. Reading them asks first, even though reads are otherwise free. */
export function isSecretPath(abs: string): boolean {
  const base = path.basename(abs).toLowerCase();
  return /^\.env(\..+)?$/.test(base) && base !== '.env.example' || /\.(pem|key|pfx|p12)$/.test(base) || base === 'id_rsa' || base === 'id_ed25519';
}
