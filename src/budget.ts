import path from 'node:path';
import { HOME, budgetOf, type Config } from './config.ts';
import type { BudgetStatus } from './types.ts';
import { readJson, writeJsonAtomic } from './util.ts';

/**
 * Per-user spending ledger, kept in the user's home directory.
 *
 * The check runs before every model call, on an estimate of that call's worst-case cost, so a
 * call that would cross the limit is never sent. Actual cost is recorded afterwards. The ledger
 * is shared by every session the user runs, in any repo, in the terminal or the web UI.
 */
const LEDGER = path.join(HOME, 'ledger.json');

interface Entry {
  periodKey: string;
  spentUsd: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}
type Ledger = Record<string, Entry>;

export class BudgetExceededError extends Error {
  status: BudgetStatus;
  estimateUsd: number;
  constructor(status: BudgetStatus, estimateUsd: number) {
    super(`Budget reached for ${status.user}: spent $${status.spentUsd.toFixed(4)} of $${status.limitUsd.toFixed(2)} this ${status.period}`);
    this.name = 'BudgetExceededError';
    this.status = status;
    this.estimateUsd = estimateUsd;
  }
}

function periodKey(period: 'day' | 'month', now = new Date()): string {
  const iso = now.toISOString();
  return period === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

export class Budget {
  private cfg: Config;
  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private entry(ledger: Ledger): Entry {
    const key = periodKey(budgetOf(this.cfg).period);
    const e = ledger[this.cfg.user];
    if (!e || e.periodKey !== key) {
      return (ledger[this.cfg.user] = { periodKey: key, spentUsd: 0, calls: 0, tokensIn: 0, tokensOut: 0 });
    }
    return e;
  }

  status(): BudgetStatus {
    const e = this.entry(readJson<Ledger>(LEDGER, {}));
    const b = budgetOf(this.cfg);
    return { user: this.cfg.user, spentUsd: e.spentUsd, limitUsd: b.limitUsd, period: b.period };
  }

  /** Throws if this call could take the user past their limit. Free (local) calls always pass. */
  assertCanSpend(estimateUsd: number): void {
    if (estimateUsd <= 0) return;
    const status = this.status();
    if (status.spentUsd + estimateUsd > status.limitUsd) throw new BudgetExceededError(status, estimateUsd);
  }

  record(costUsd: number, tokensIn: number, tokensOut: number): BudgetStatus {
    // Re-read before writing: another session of the same user may have spent in the meantime.
    const ledger = readJson<Ledger>(LEDGER, {});
    const e = this.entry(ledger);
    e.spentUsd += costUsd;
    e.calls += 1;
    e.tokensIn += tokensIn;
    e.tokensOut += tokensOut;
    writeJsonAtomic(LEDGER, ledger);
    return this.status();
  }
}
