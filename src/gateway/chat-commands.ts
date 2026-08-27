import type { AgentReply, Session } from '../types.js';
import type { Gateway } from '../gateway.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import { GARUD_BUILD, GARUD_VERSION } from '../version.js';

export interface ChatCommandContext {
  session: Session;
  gateway: Gateway;
  requestId: string;
}

export interface ChatCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: ChatCommandContext) => Promise<string> | string;
}

/**
 * In-chat slash commands (OpenClaw-style). Works on every channel: WebChat,
 * Telegram, webhooks, CLI. Messages starting with "/" are intercepted before
 * they reach the brain, handled deterministically, and never consume LLM
 * budget.
 */
export class ChatCommandRouter {
  private readonly commands = new Map<string, ChatCommand>();

  register(command: ChatCommand): void {
    const key = command.name.toLowerCase();
    if (this.commands.has(key)) throw new Error(`command already registered: /${key}`);
    this.commands.set(key, command);
  }

  list(): ChatCommand[] {
    return [...this.commands.values()];
  }

  matches(text: string): boolean {
    return /^\/[a-z]/i.test(text.trim());
  }

  async execute(text: string, ctx: ChatCommandContext): Promise<AgentReply | undefined> {
    const trimmed = text.trim();
    if (!this.matches(trimmed)) return undefined;
    const [head = '', ...rest] = trimmed.slice(1).split(/\s+/);
    const command = this.commands.get(head.toLowerCase());
    const make = (replyText: string, note: string): AgentReply => ({
      text: replyText, notes: [note], usedTools: [], usedMemories: [], requestId: ctx.requestId
    });
    if (!command) {
      const known = [...this.commands.keys()].sort().map((c) => `/${c}`).join(', ');
      return make(`unknown command: /${head} — try ${known || '/help'}`, 'command:unknown');
    }
    try {
      const out = await command.handler(rest.join(' '), ctx);
      return make(out, `command:${command.name}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return make(`command /${command.name} failed: ${msg}`, 'command:error');
    }
  }
}

/** Registers the built-in command set every OpenClaw-style gateway ships with. */
export function buildDefaultChatCommands(
  router: ChatCommandRouter,
  deps: { conversation?: ConversationStore } = {}
): void {
  router.register({
    name: 'help',
    description: 'List available commands',
    handler: () => {
      const lines = router.list()
        .map((c) => `/${c.name} — ${c.description}`)
        .sort((a, b) => a.localeCompare(b));
      return `Garud v${GARUD_VERSION} "${GARUD_BUILD.codename}" commands:\n${lines.join('\n')}`;
    }
  });
  router.register({
    name: 'status',
    description: 'Gateway status for your session',
    handler: (_args, ctx) => {
      const stats = ctx.gateway.getStats();
      return `agent=${ctx.session.agentId} channel=${ctx.session.channel} trust=${ctx.session.trustLevel}`
        + ` · handled=${stats.handled} sessions=${stats.sessions} memories=${stats.memories}`;
    }
  });
  router.register({
    name: 'whoami',
    description: 'Show your session identity',
    handler: (_args, ctx) =>
      `you are ${ctx.session.userId} on ${ctx.session.channel}`
      + ` (trust: ${ctx.session.trustLevel}, agent: ${ctx.session.agentId}, session: ${ctx.session.id.slice(0, 8)})`
  });
  router.register({
    name: 'version',
    description: 'Show gateway version',
    handler: () => `garud-agent ${GARUD_VERSION} "${GARUD_BUILD.codename}" (released ${GARUD_BUILD.releasedAt})`
  });
  router.register({
    name: 'new',
    description: 'Start a fresh conversation (clears history)',
    handler: (_args, ctx) => {
      const cleared = deps.conversation?.clear(ctx.session.id) ?? 0;
      return cleared > 0
        ? `fresh start — cleared ${cleared} turns of history`
        : 'fresh start — no history to clear';
    }
  });
  router.register({
    name: 'compact',
    description: 'Compact conversation context, keeping the 2 most recent turns',
    handler: (_args, ctx) => {
      if (!deps.conversation) return 'conversation history is disabled — nothing to compact';
      const turns = deps.conversation.list(ctx.session.id);
      if (turns.length <= 2) return `context is small (${turns.length} turns) — no compaction needed`;
      const keep = turns.slice(-2);
      deps.conversation.clear(ctx.session.id);
      for (const t of keep) {
        deps.conversation.append({
          sessionId: t.sessionId,
          requestId: t.requestId,
          input: t.input,
          reply: t.reply,
          toolsUsed: t.toolsUsed
        });
      }
      return `compacted context: summarized away ${turns.length - keep.length} turns, kept the ${keep.length} most recent`;
    }
  });
  router.register({
    name: 'pair',
    description: 'Redeem a pairing code: /pair <code>',
    handler: (args, ctx) => {
      const code = args.trim();
      if (!code) return 'usage: /pair <code>';
      const result = ctx.gateway.redeemPairing(code);
      if (!result.ok) return 'invalid or expired pairing code';
      return `paired! ${result.channel}/${result.userId} is now ${result.trustLevel}`;
    }
  });
}
