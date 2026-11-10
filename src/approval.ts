import crypto from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, Category, Frontend } from './types.ts';

/**
 * The single choke point for anything that changes the world.
 *
 * Every write, shell command and git operation passes through `check` before it runs. The only
 * inputs that can produce an "allow" are: a human answering the prompt, a command the human
 * chose to always allow earlier in this session, or pre-approvals the human typed on the command
 * line when starting the agent. No tool argument, file content, web result or model output is
 * consulted, so there is nothing for a prompt to override.
 */
export interface PreApprovals {
  /** `--yes-writes`: file edits inside the repo are approved up front. */
  writes: boolean;
  /** `--allow-cmd "npm test"`: exact commands approved up front. */
  commands: string[];
}

export class ApprovalGate {
  private frontend: Frontend;
  private pre: PreApprovals;
  private sessionCommands = new Set<string>();
  private sessionWrites = false;

  constructor(frontend: Frontend, pre: PreApprovals) {
    this.frontend = frontend;
    this.pre = pre;
  }

  async check(req: Omit<ApprovalRequest, 'id'>): Promise<ApprovalDecision> {
    const request: ApprovalRequest = { ...req, id: crypto.randomUUID() };

    // Anything flagged with a warning always goes to the human, whatever was pre-approved.
    if (request.warnings.length === 0) {
      const auto =
        request.category === 'read'
          ? false
          : request.category === 'write'
            ? this.pre.writes || this.sessionWrites
            : this.pre.commands.includes(request.detail) || this.sessionCommands.has(request.detail);
      if (auto) {
        this.frontend.emit({ type: 'approval_result', id: request.id, allow: true, auto: true });
        return { allow: true };
      }
    }

    this.frontend.emit({ type: 'approval_request', request });
    const decision = await this.frontend.approve(request);
    if (decision.allow && decision.remember && request.canRemember) {
      if (request.category === 'write') this.sessionWrites = true;
      else this.sessionCommands.add(request.detail);
    }
    this.frontend.emit({ type: 'approval_result', id: request.id, allow: decision.allow, auto: false });
    return decision;
  }
}

/** A shell command that invokes git is a git operation, wherever in the command line git appears. */
export function categorizeCommand(command: string): Extract<Category, 'shell' | 'git'> {
  return /(^|[\s;&|(`$])git(\.exe)?(\s|$)/i.test(command) ? 'git' : 'shell';
}

const RISKY: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]|\brmdir\b|\bdel\s|Remove-Item|\bformat\b/i, 'deletes files'],
  [/\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|rebase|filter-branch)|--force\b/i, 'rewrites or publishes git history'],
  [/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|scp|sftp|ssh)\b/i, 'talks to the network'],
  [/\b(sudo|runas|chmod|chown|icacls|reg\s+add|setx)\b/i, 'changes permissions or system settings'],
  [/\bfrugal\b/i, 'invokes the agent itself'],
  [/[>|]\s*[^\s]*\.(frugal|git)\b|\.frugal[\\/]|\.env\b/i, 'touches policy, git internals or secrets'],
];

export function commandWarnings(command: string, confidential: boolean): string[] {
  const out = RISKY.filter(([re]) => re.test(command)).map(([, why]) => why);
  if (confidential && out.includes('talks to the network')) {
    out.push('this repository is confidential: check that no code leaves this machine');
  }
  return out;
}
