export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type Tier = 'fast' | 'strong' | 'local';

/** What an action does to the world. Only `read` runs without asking. */
export type Category = 'read' | 'write' | 'shell' | 'git';

export interface ApprovalRequest {
  id: string;
  /** `read` only appears here for credential files, which ask even though other reads are free. */
  category: Category;
  tool: string;
  /** One line: what will happen. */
  summary: string;
  /** The diff or the exact command. */
  detail: string;
  /** Reasons this action deserves a closer look. */
  warnings: string[];
  /** Whether "always allow for this session" may be offered. */
  canRemember: boolean;
}

export interface ApprovalDecision {
  allow: boolean;
  /** Also allow this exact action for the rest of the session. */
  remember?: boolean;
  /** Optional note from the user, passed back to the model on denial. */
  note?: string;
}

export type BudgetChoice = { action: 'local' } | { action: 'raise'; limitUsd: number } | { action: 'stop' };

export interface BudgetStatus {
  user: string;
  spentUsd: number;
  limitUsd: number;
  period: 'day' | 'month';
}

export interface Stats {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
  toolCalls: number;
  /** Tokens we avoided sending: deduped re-reads, truncated output, compacted history. */
  tokensSaved: number;
  failovers: number;
  byModel: Record<string, { calls: number; tokensIn: number; tokensOut: number; costUsd: number }>;
}

/** Everything a front end needs to render a session. The terminal and the web UI consume the same stream. */
export type AgentEvent =
  /** A piece of the reply as it is being written. Always followed by `text` (the whole reply) or `text_clear`. */
  | { type: 'text_delta'; text: string }
  /** The streamed pieces turned out not to be a message for the user; remove them. */
  | { type: 'text_clear' }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; tool: string; summary: string; category: Category }
  | { type: 'tool_end'; id: string; ok: boolean; preview: string }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_result'; id: string; allow: boolean; auto: boolean }
  | { type: 'model'; model: string; previous: string | null; reason: string; failedOver: boolean }
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
  | { type: 'budget'; status: BudgetStatus }
  | { type: 'budget_limit'; status: BudgetStatus; estimateUsd: number }
  | { type: 'usage'; stats: Stats; model: string }
  | { type: 'turn_end'; reason: 'done' | 'stopped' | 'budget' | 'error' | 'max_steps'; error?: string };

/** The front end's side of the contract: it renders events and answers the two questions only a human may answer. */
export interface Frontend {
  emit(event: AgentEvent): void;
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  budgetLimit(status: BudgetStatus, estimateUsd: number): Promise<BudgetChoice>;
}
