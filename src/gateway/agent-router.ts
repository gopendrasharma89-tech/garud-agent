import type { AgentBinding, IncomingMessage } from '../types.js';

/**
 * Routes inbound messages to agents via bindings (OpenClaw-style).
 * Most-specific match wins: userId (4) > channel (2) > userPrefix (1).
 * Falls back to the default agent when nothing matches.
 */
export class AgentRouter {
  private readonly bindings: AgentBinding[];

  constructor(bindings: AgentBinding[] = [], private readonly defaultAgentId = 'main') {
    this.bindings = bindings.filter((b) => !!b?.agentId);
  }

  add(binding: AgentBinding): void {
    if (binding?.agentId) this.bindings.push(binding);
  }

  list(): AgentBinding[] {
    return [...this.bindings];
  }

  resolve(message: Pick<IncomingMessage, 'channel' | 'userId'>): string {
    let best: { score: number; agentId: string } | undefined;
    for (const b of this.bindings) {
      let score = 0;
      if (b.channel) {
        if (b.channel !== message.channel) continue;
        score += 2;
      }
      if (b.userId) {
        if (b.userId !== message.userId) continue;
        score += 4;
      }
      if (b.userPrefix) {
        if (!message.userId.startsWith(b.userPrefix)) continue;
        score += 1;
      }
      if (score === 0) continue;
      if (!best || score > best.score) best = { score, agentId: b.agentId };
    }
    return best?.agentId ?? this.defaultAgentId;
  }
}
