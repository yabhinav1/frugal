import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { HOME } from './config.ts';
import { readJson, writeJsonAtomic } from './util.ts';

const CACHE = path.join(HOME, 'runtimes.json');
const CANDIDATES = ['node', 'npm', 'bun', 'python', 'python3', 'go', 'cargo', 'java', 'dotnet', 'git', 'docker'];
const DAY_MS = 24 * 60 * 60 * 1000;

interface Cache {
  checkedAt: number;
  installed: string[];
  missing: string[];
}

/**
 * Which common toolchains exist on this machine. Told to the model up front, so it does not
 * write a script in a language that cannot run here and then spend calls discovering that.
 * Each tool is asked for its version once a day; the answer is cached.
 */
export function detectRuntimes(): { installed: string[]; missing: string[] } {
  const cached = readJson<Cache | null>(CACHE, null);
  if (cached && Date.now() - cached.checkedAt < DAY_MS) return cached;
  const installed: string[] = [];
  const missing: string[] = [];
  for (const tool of CANDIDATES) {
    // Windows ships a `python` stub that only opens the Store; a real install exits 0 here.
    const r = spawnSync(`${tool} --version`, { shell: true, timeout: 4000, windowsHide: true, stdio: 'ignore' });
    (r.status === 0 ? installed : missing).push(tool);
  }
  const result = { checkedAt: Date.now(), installed, missing };
  writeJsonAtomic(CACHE, result);
  return result;
}
