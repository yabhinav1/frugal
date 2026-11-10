import readline from 'node:readline';
import type { Agent } from '../agent.ts';
import type { AgentEvent, ApprovalDecision, ApprovalRequest, BudgetChoice, BudgetStatus, Frontend, Stats } from '../types.ts';
import { c, fmtTokens, fmtUsd } from '../util.ts';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Terminal front end: renders the event stream and asks the human the questions only a human may answer. */
export class TerminalUI implements Frontend {
  private rl: readline.Interface | null = null;
  private interactive: boolean;
  private spin: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = 'thinking';
  private lastStats: Stats | null = null;
  private lastModel = '';
  private lastBudget: BudgetStatus | null = null;
  /** Resolves when the current turn ends. */
  private turnDone: (() => void) | null = null;
  private closed = false;
  /** Tool calls in flight that are shell or git commands, whose output is worth showing. */
  private commands = new Set<string>();
  private pendingAnswer: ((answer: string) => void) | null = null;
  exitCode = 0;

  constructor(interactive: boolean) {
    this.interactive = interactive;
    if (interactive) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      // Ctrl+D or a closed input stream: answer any open question so nothing hangs.
      this.rl.on('close', () => {
        this.closed = true;
        this.pendingAnswer?.('');
      });
    }
  }

  // ---- output ----

  private startSpinner(label: string): void {
    this.label = label;
    if (!process.stdout.isTTY || this.spin) return;
    this.spin = setInterval(() => {
      process.stdout.write(`\r${c.cyan(FRAMES[this.frame++ % FRAMES.length]!)} ${c.dim(this.label)}\x1b[K`);
    }, 80);
  }

  private stopSpinner(): void {
    if (!this.spin) return;
    clearInterval(this.spin);
    this.spin = null;
    process.stdout.write('\r\x1b[K');
  }

  print(text = ''): void {
    const spinning = !!this.spin;
    this.stopSpinner();
    process.stdout.write(`${text}\n`);
    if (spinning) this.startSpinner(this.label);
  }

  emit(e: AgentEvent): void {
    switch (e.type) {
      case 'text':
        this.print(`\n${e.text}`);
        break;
      case 'tool_start': {
        const mark = e.category === 'read' ? c.dim('●') : e.category === 'write' ? c.green('●') : c.magenta('●');
        this.print(`  ${mark} ${c.dim(e.summary)}`);
        this.label = e.summary.slice(0, 60);
        if (e.category === 'shell' || e.category === 'git') this.commands.add(e.id);
        break;
      }
      case 'tool_end':
        if (this.commands.delete(e.id) && !/^The user denied/.test(e.preview)) {
          // Show what the command printed: the first lines, with the exit status.
          const lines = e.preview.split('\n').filter((l) => l.trim());
          for (const line of lines.slice(0, 12)) this.print(`    ${e.ok ? c.dim(line) : c.red(line)}`);
          if (lines.length > 12) this.print(c.dim(`    … ${lines.length - 12} more lines`));
        } else if (!e.ok) this.print(`    ${c.red('✗')} ${c.dim(e.preview.split('\n')[0] ?? '')}`);
        this.label = 'thinking';
        break;
      case 'approval_result':
        if (e.auto) this.print(`    ${c.dim('✓ pre-approved')}`);
        break;
      case 'model':
        if (e.previous === null && !e.failedOver) this.print(c.dim(`  model: ${e.model}`));
        else if (e.previous === null) this.print(c.yellow(`  ⇄ Answering model: ${e.model} (${e.reason})`));
        else this.print(c.yellow(`  ⇄ Model changed: ${e.previous} → ${e.model} (${e.reason})`));
        this.lastModel = e.model;
        break;
      case 'notice':
        this.print(e.level === 'warn' ? c.yellow(`  ! ${e.text}`) : c.dim(`  ${e.text}`));
        break;
      case 'usage':
        this.lastStats = e.stats;
        this.lastModel = e.model;
        break;
      case 'budget':
        this.lastBudget = e.status;
        break;
      case 'turn_end':
        this.stopSpinner();
        if (e.reason === 'error') {
          this.print(c.red(`\n  Error: ${e.error}`));
          this.exitCode = 1;
        } else if (e.reason === 'stopped') this.print(c.yellow('\n  Stopped. The session is saved; send another message to continue.'));
        else if (e.reason === 'max_steps') this.print(c.yellow('\n  Step limit reached. Send "continue" to keep going.'));
        else if (e.reason === 'budget') this.exitCode = 3;
        this.print(this.statusLine());
        this.turnDone?.();
        break;
      default:
        break;
    }
  }

  statusLine(): string {
    const s = this.lastStats;
    const b = this.lastBudget;
    const parts = [
      s ? `${fmtTokens(s.tokensIn)} in / ${fmtTokens(s.tokensOut)} out` : 'no model calls yet',
      s && s.tokensSaved ? `${fmtTokens(s.tokensSaved)} saved` : '',
      s ? fmtUsd(s.costUsd) : '',
      b ? `budget ${fmtUsd(b.spentUsd)} of ${fmtUsd(b.limitUsd)}/${b.period}` : '',
      this.lastModel,
    ].filter(Boolean);
    return c.dim(`  ${parts.join(' · ')}`);
  }

  // ---- input ----

  /** True once the input stream has ended; the chat loop uses it to exit. */
  get inputClosed(): boolean {
    return this.closed;
  }

  ask(prompt: string): Promise<string> {
    this.stopSpinner();
    return new Promise((resolve) => {
      if (!this.rl || this.closed) return resolve('');
      this.pendingAnswer = resolve;
      this.rl.question(prompt, (answer) => {
        this.pendingAnswer = null;
        resolve(answer.trim());
      });
    });
  }

  async approve(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.stopSpinner();
    const title = { read: 'Read', write: 'File change', shell: 'Shell command', git: 'Git operation' }[req.category];
    console.log(`\n  ${c.bold(c.yellow(`▲ ${title} needs your approval`))}  ${req.summary}`);
    for (const w of req.warnings) console.log(`  ${c.red(`! ${w}`)}`);
    for (const line of req.detail.split('\n')) {
      const colored = line.startsWith('+ ') ? c.green(line) : line.startsWith('- ') ? c.red(line) : line.startsWith('@@') ? c.cyan(line) : line;
      console.log(`    ${colored}`);
    }
    if (!this.interactive) {
      console.log(c.yellow('  Not approved: no terminal to ask. Start with --yes-writes or --allow-cmd "<command>" to approve up front.'));
      return { allow: false, note: 'No human was available to approve.' };
    }
    const canAlways = req.canRemember && req.warnings.length === 0;
    const always = canAlways ? (req.category === 'write' ? ' / [a]ll edits this session' : ' / [a]lways this exact command') : '';
    for (;;) {
      const answer = (await this.ask(`  Allow? [y]es / [n]o${always} / or type a reason to refuse: `)).toLowerCase();
      if (this.closed) return { allow: false, note: 'The terminal was closed before a decision.' };
      if (answer === 'y' || answer === 'yes') return this.resume({ allow: true });
      if (canAlways && (answer === 'a' || answer === 'always')) return this.resume({ allow: true, remember: true });
      if (answer === 'n' || answer === 'no' || answer === '') return this.resume({ allow: false });
      if (answer.length > 2) return this.resume({ allow: false, note: answer });
    }
  }

  private resume<T>(value: T): T {
    this.startSpinner('working');
    return value;
  }

  async budgetLimit(status: BudgetStatus, estimateUsd: number): Promise<BudgetChoice> {
    this.stopSpinner();
    console.log(`\n  ${c.bold(c.red('■ Spending limit reached'))}`);
    console.log(`  ${status.user} has spent ${fmtUsd(status.spentUsd)} of ${fmtUsd(status.limitUsd)} this ${status.period}. The next call (about ${fmtUsd(estimateUsd)}) was not sent.`);
    if (!this.interactive) {
      console.log(c.yellow('  Stopping: no terminal to ask. The session is saved.'));
      return { action: 'stop' };
    }
    for (;;) {
      const answer = (await this.ask('  [l] continue on the free local model / [r] raise the limit / [s] stop and save: ')).toLowerCase();
      if (this.closed) return { action: 'stop' };
      if (answer === 'l') return this.resume({ action: 'local' });
      if (answer === 's' || answer === '') return { action: 'stop' };
      if (answer === 'r') {
        const n = Number(await this.ask(`  New limit in USD (currently ${status.limitUsd}): `));
        if (n > status.limitUsd) return this.resume({ action: 'raise', limitUsd: n });
        console.log(c.yellow('  The new limit must be higher than the current one.'));
      }
    }
  }

  /** Run one turn and wait for it to finish. Ctrl+C stops the turn instead of quitting. */
  async turn(agent: Agent, text: string): Promise<void> {
    const done = new Promise<void>((resolve) => (this.turnDone = resolve));
    const onSigint = () => {
      this.print(c.yellow('  Stopping…'));
      agent.stop();
    };
    this.rl?.on('SIGINT', onSigint);
    process.on('SIGINT', onSigint);
    this.startSpinner('thinking');
    try {
      await agent.runTurn(text);
      await done;
    } finally {
      this.stopSpinner();
      this.rl?.off('SIGINT', onSigint);
      process.off('SIGINT', onSigint);
      this.turnDone = null;
    }
  }

  close(): void {
    this.stopSpinner();
    this.rl?.close();
  }
}

/** Machine-readable front end for benchmarks and scripts: one JSON event per line, never prompts. */
export class JsonFrontend implements Frontend {
  exitCode = 0;
  emit(e: AgentEvent): void {
    if (e.type === 'turn_end' && e.reason === 'error') this.exitCode = 1;
    if (e.type === 'turn_end' && e.reason === 'budget') this.exitCode = 3;
    process.stdout.write(`${JSON.stringify(e)}\n`);
  }
  async approve(): Promise<ApprovalDecision> {
    return { allow: false, note: 'Non-interactive run: not pre-approved.' };
  }
  async budgetLimit(): Promise<BudgetChoice> {
    return { action: 'stop' };
  }
}
