import { AgentPlan, AgentReply, ConversationTurn, Memory, Session, ToolDefinition, ToolResult } from '../types.js';

export interface BrainPlanContext {
  input: string;
  session: Session;
  availableTools: ToolDefinition[];
  recentMemories: Memory[];
  signal?: AbortSignal;
}

export interface BrainComposeContext {
  input: string;
  session: Session;
  memories: Memory[];
  toolOutputs: Array<{ tool: string; result: ToolResult }>;
  /** Free-form persona/system prompt. */
  persona?: string;
  /** Skill snippets injected from the skills directory. */
  skills?: Array<{ name: string; content: string }>;
  /** Recent conversation turns for continuity. */
  history?: ConversationTurn[];
  signal?: AbortSignal;
}

export interface BrainProvider {
  readonly name: string;
  plan(context: BrainPlanContext): Promise<AgentPlan> | AgentPlan;
  compose(context: BrainComposeContext): Promise<AgentReply> | AgentReply;
}
