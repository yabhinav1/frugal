import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.ts';
import { emptyStats } from './gateway/router.ts';
import type { Message, Stats, Tier } from './types.ts';
import { readJson, writeJsonAtomic } from './util.ts';

const DIR = path.join(HOME, 'sessions');

/**
 * A session is saved to disk after every step, so a crash, a closed terminal or a provider
 * outage never loses work: `frugal --continue` picks up from the last completed step.
 */
export interface Session {
  id: string;
  root: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Conversation without the system prompt, which is rebuilt on load. */
  messages: Message[];
  stats: Stats;
  tier: Tier;
  /** The user chose to continue on the local model after reaching their budget. */
  userLocalOnly: boolean;
}

export function newSession(root: string): Session {
  const now = new Date().toISOString();
  return {
    id: `${now.slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`,
    root,
    title: '',
    createdAt: now,
    updatedAt: now,
    messages: [],
    stats: emptyStats(),
    tier: 'fast',
    userLocalOnly: false,
  };
}

export function saveSession(s: Session): void {
  s.updatedAt = new Date().toISOString();
  writeJsonAtomic(path.join(DIR, `${s.id}.json`), s);
}

export function loadSession(id: string): Session | null {
  return readJson<Session | null>(path.join(DIR, `${path.basename(id)}.json`), null);
}

export function listSessions(root?: string): Session[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return files
    .map((f) => readJson<Session | null>(path.join(DIR, f), null))
    .filter((s): s is Session => !!s && (!root || same(s.root, root)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
