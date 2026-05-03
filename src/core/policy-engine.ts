import { PolicyDecision, PolicyRule, Session, ToolDefinition } from '../types.js';
import { matchPattern } from '../utils/text.js';

export const DEFAULT_RULES: PolicyRule[] = [
  { id: 'owner-allow-all', trustLevels: ['owner'], tools: ['*'], effect: 'allow' },
  { id: 'trusted-no-shell', trustLevels: ['trusted'], tags: ['shell', 'destructive'], effect: 'deny' },
  { id: 'trusted-allow-rest', trustLevels: ['trusted'], tools: ['*'], effect: 'allow' },
  { id: 'guest-deny-write', trustLevels: ['guest'], tags: ['write', 'shell', 'destructive', 'network'], effect: 'deny' },
  { id: 'guest-allow-safe', trustLevels: ['guest'], tags: ['safe'], effect: 'allow', sandbox: true },
  { id: 'guest-allow-status', trustLevels: ['guest'], tools: ['status', 'time.now', 'echo'], effect: 'allow', sandbox: true },
  { id: 'guest-default-deny', trustLevels: ['guest'], tools: ['*'], effect: 'deny' },
  { id: 'blocked-deny-all', trustLevels: ['blocked'], tools: ['*'], effect: 'deny' }
];

export interface PolicyEngineOptions {
  rules?: PolicyRule[];
}

export class PolicyEngine {
  private rules: PolicyRule[];

  constructor(options: PolicyEngineOptions = {}) {
    this.rules = options.rules ?? DEFAULT_RULES;
  }

  setRules(rules: PolicyRule[]): void {
    this.rules = rules;
  }

  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  prependRule(rule: PolicyRule): void {
    this.rules = [rule, ...this.rules];
  }

  appendRule(rule: PolicyRule): void {
    this.rules = [...this.rules, rule];
  }

  removeRule(id: string): boolean {
    const next = this.rules.filter((r) => r.id !== id);
    if (next.length === this.rules.length) return false;
    this.rules = next;
    return true;
  }

  decide(session: Session, tool: ToolDefinition): PolicyDecision {
    for (const rule of this.rules) {
      if (rule.trustLevels && !rule.trustLevels.includes(session.trustLevel)) continue;

      let matched = false;
      if (rule.tools) {
        matched = rule.tools.some((pattern) => matchPattern(pattern, tool.name));
      }
      if (!matched && rule.tags && tool.tags) {
        matched = rule.tags.some((tag) => tool.tags!.includes(tag));
      }
      if (!matched && !rule.tools && !rule.tags) continue;
      if (!matched) continue;

      return {
        allow: rule.effect === 'allow',
        reason: rule.reason ?? `${rule.id}:${rule.effect}`,
        sandbox: rule.sandbox ?? false
      };
    }
    return { allow: false, reason: 'no-matching-rule', sandbox: false };
  }
}
