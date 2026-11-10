import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { HOME } from './config.ts';
import { readJson, writeJsonAtomic } from './util.ts';

const CACHE = path.join(HOME, 'runtimes.json');
/**
 * Each tool with the commands that may launch it, in order of preference. Python is the reason
 * for the alternatives: on Windows the real interpreter is often reachable only as `py`, while
 * `python` is a stub that tells you to visit the Store.
 */
const CANDIDATES: [string, string[]][] = [
  ['node', ['node']],
  ['npm', ['npm']],
  ['bun', ['bun']],
  ['python', process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']],
  ['go', ['go']],
  ['cargo', ['cargo']],
  ['java', ['java']],
  ['dotnet', ['dotnet']],
  ['git', ['git']],
  ['docker', ['docker']],
];
const DAY_MS = 24 * 60 * 60 * 1000;

interface Cache {
  checkedAt: number;
  /** Bumped when the detection logic changes, so old answers are thrown away. */
  version?: number;
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
  if (cached && cached.version === 2 && Date.now() - cached.checkedAt < DAY_MS) return cached;
  const installed: string[] = [];
  const missing: string[] = [];
  for (const [tool, commands] of CANDIDATES) {
    // A real install exits 0 when asked for its version; the Windows Store stub does not.
    const works = commands.find((cmd) => spawnSync(`${cmd} --version`, { shell: true, timeout: 4000, windowsHide: true, stdio: 'ignore' }).status === 0);
    if (!works) missing.push(tool);
    // When the working command is not the obvious one, say which to type.
    else installed.push(works === tool ? tool : `${tool} (run it as \`${works}\`, not \`${tool}\`)`);
  }
  const result = { checkedAt: Date.now(), version: 2, installed, missing };
  writeJsonAtomic(CACHE, result);
  return result;
}
