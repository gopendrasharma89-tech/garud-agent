import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, PolicyEngine } from '../src/core/policy-engine.js';
import { Session, ToolDefinition, TrustLevel } from '../src/types.js';

function makeSession(trustLevel: TrustLevel): Session {
  return {
    id: 's1', channel: 'http', userId: 'u1', trustLevel, role: 'main', agentId: 'main',
    createdAt: 0, updatedAt: 0, messageCount: 0, settings: {}
  };
}

function tool(name: string, tags: string[] = []): ToolDefinition {
  return { name, description: name, tags, execute: () => ({ content: 'ok' }) };
}

describe('PolicyEngine', () => {
  const engine = new PolicyEngine({ rules: DEFAULT_RULES });

  it('allows owners everything', () => {
    const decision = engine.decide(makeSession('owner'), tool('memory.save', ['write']));
    expect(decision.allow).toBe(true);
  });

  it('denies trusted users shell access', () => {
    const decision = engine.decide(makeSession('trusted'), tool('shell.run', ['shell']));
    expect(decision.allow).toBe(false);
  });

  it('allows trusted user safe tools', () => {
    const decision = engine.decide(makeSession('trusted'), tool('time.now', ['read', 'safe']));
    expect(decision.allow).toBe(true);
  });

  it('allows guest safe utility tools sandboxed', () => {
    const decision = engine.decide(makeSession('guest'), tool('time.now', ['read', 'safe']));
    expect(decision.allow).toBe(true);
    expect(decision.sandbox).toBe(true);
  });

  it('blocks guest write tools', () => {
    const decision = engine.decide(makeSession('guest'), tool('memory.save', ['write']));
    expect(decision.allow).toBe(false);
  });

  it('blocks guest network tools by default', () => {
    const decision = engine.decide(makeSession('guest'), tool('http.fetch', ['read', 'network']));
    expect(decision.allow).toBe(false);
  });

  it('blocks blocked users entirely', () => {
    const decision = engine.decide(makeSession('blocked'), tool('time.now', ['read', 'safe']));
    expect(decision.allow).toBe(false);
  });

  it('first matching rule wins', () => {
    const custom = new PolicyEngine({
      rules: [
        { id: 'force-allow', tools: ['*'], effect: 'allow' },
        { id: 'never-runs', tools: ['*'], effect: 'deny' }
      ]
    });
    const decision = custom.decide(makeSession('guest'), tool('anything'));
    expect(decision.allow).toBe(true);
    expect(decision.reason).toContain('force-allow');
  });

  it('prependRule has higher priority than existing rules', () => {
    const e = new PolicyEngine({ rules: DEFAULT_RULES });
    e.prependRule({ id: 'top', tools: ['*'], effect: 'deny', reason: 'top-deny' });
    const decision = e.decide(makeSession('owner'), tool('anything'));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('top-deny');
  });

  it('appendRule has lowest priority', () => {
    const e = new PolicyEngine({ rules: [
      { id: 'first', tools: ['x'], effect: 'allow' }
    ] });
    e.appendRule({ id: 'fallback', tools: ['*'], effect: 'deny' });
    const dec = e.decide(makeSession('guest'), tool('x'));
    expect(dec.allow).toBe(true);
    const dec2 = e.decide(makeSession('guest'), tool('y'));
    expect(dec2.allow).toBe(false);
  });

  it('removeRule deletes by id', () => {
    const e = new PolicyEngine({
      rules: [
        { id: 'a', tools: ['*'], effect: 'deny' },
        { id: 'b', tools: ['*'], effect: 'allow' }
      ]
    });
    expect(e.removeRule('a')).toBe(true);
    expect(e.decide(makeSession('owner'), tool('x')).allow).toBe(true);
    expect(e.removeRule('a')).toBe(false);
  });

  it('returns no-matching-rule when nothing matches', () => {
    const empty = new PolicyEngine({ rules: [] });
    const dec = empty.decide(makeSession('owner'), tool('x'));
    expect(dec.allow).toBe(false);
    expect(dec.reason).toBe('no-matching-rule');
  });
});
