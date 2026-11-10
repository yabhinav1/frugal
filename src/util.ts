import fs from 'node:fs';
import path from 'node:path';

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file and rename, so a crash mid-write never leaves a half-written file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse the rename while another process has the target open.
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    fs.rmSync(tmp, { force: true });
  }
}

/** Cheap token estimate. Deliberately a little high so budget checks err on the safe side. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Keep the head and tail of long output; the middle is usually the least useful part. */
export function truncateMiddle(text: string, maxChars: number): { text: string; dropped: number } {
  if (text.length <= maxChars) return { text, dropped: 0 };
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const dropped = text.length - maxChars;
  return {
    text: `${text.slice(0, head)}\n… [${dropped} chars omitted] …\n${text.slice(text.length - tail)}`,
    dropped,
  };
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: wrap(2),
  bold: wrap(1),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
};
