import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, ApprovalDecision, ApprovalRequest, BudgetChoice, Frontend } from '../src/types.ts';

/** Point the agent's home at a fresh temp directory. Must run before any src module is imported. */
export function isolateHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-home-'));
  process.env.FRUGAL_HOME = dir;
  for (const k of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY', 'TAVILY_API_KEY', 'FRUGAL_CONFIDENTIAL']) delete process.env[k];
  return dir;
}

export function tempRepo(files: Record<string, string> = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-repo-')));
  fs.mkdirSync(path.join(dir, '.git'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** A front end that records everything and answers approvals with a scripted function. */
export class FakeFrontend implements Frontend {
  events: AgentEvent[] = [];
  asked: ApprovalRequest[] = [];
  answer: (req: ApprovalRequest) => ApprovalDecision = () => ({ allow: false });
  budgetChoice: BudgetChoice = { action: 'stop' };

  emit(e: AgentEvent): void {
    this.events.push(e);
  }
  async approve(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.asked.push(req);
    return this.answer(req);
  }
  async budgetLimit(): Promise<BudgetChoice> {
    return this.budgetChoice;
  }
  ofType<T extends AgentEvent['type']>(type: T): Extract<AgentEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
  }
}
