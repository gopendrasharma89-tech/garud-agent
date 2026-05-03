import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { Session, ToolDefinition } from '../src/types.js';
import { noopLogger } from '../src/utils/logger.js';

const session: Session = {
  id: 's1', channel: 'http', userId: 'u1', trustLevel: 'owner', role: 'main', agentId: 'main',
  createdAt: 0, updatedAt: 0, messageCount: 0, settings: {}
};

const baseCtx = { session, requestText: '', now: 0, log: noopLogger };

const okTool: ToolDefinition = {
  name: 'echo', description: 'echo', execute: (input) => ({ content: input })
};

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const reg = new ToolRegistry();
    reg.register(okTool);
    expect(reg.get('echo')?.name).toBe('echo');
    expect(reg.list()).toHaveLength(1);
    expect(reg.size()).toBe(1);
  });

  it('rejects duplicate registrations', () => {
    const reg = new ToolRegistry();
    reg.register(okTool);
    expect(() => reg.register(okTool)).toThrow();
  });

  it('rejects empty tool name', () => {
    const reg = new ToolRegistry();
    expect(() => reg.register({ ...okTool, name: '' })).toThrow();
  });

  it('upserts existing tools', () => {
    const reg = new ToolRegistry();
    reg.register(okTool);
    reg.upsert({ ...okTool, description: 'new' });
    expect(reg.get('echo')?.description).toBe('new');
  });

  it('returns error result for unknown tool with suggestion', async () => {
    const reg = new ToolRegistry();
    reg.register(okTool);
    const result = await reg.invoke('echoo', '', baseCtx);
    expect(result.error).toBe(true);
    expect(result.content).toMatch(/echo/);
  });

  it('captures errors thrown by tools', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'bad', description: 'bad',
      execute: () => { throw new Error('boom'); }
    });
    const result = await reg.invoke('bad', '', baseCtx);
    expect(result.error).toBe(true);
    expect(result.content).toMatch(/boom/);
  });

  it('respects timeouts', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'slow', description: 'slow',
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ content: 'late' }), 200))
    });
    const result = await reg.invoke('slow', '', baseCtx, { timeoutMs: 20 });
    expect(result.error).toBe(true);
    expect(result.content).toMatch(/timed out/);
  });

  it('passes sandbox flag through context', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'sandbox-aware', description: 'x',
      execute: (_input, ctx) => ({ content: String(ctx.sandbox) })
    });
    const result = await reg.invoke('sandbox-aware', '', baseCtx, { sandbox: true });
    expect(result.content).toBe('true');
  });

  it('listByTags filters tools by tag', () => {
    const reg = new ToolRegistry();
    reg.register({ name: 'a', description: 'a', tags: ['safe'], execute: () => ({ content: 'x' }) });
    reg.register({ name: 'b', description: 'b', tags: ['write'], execute: () => ({ content: 'x' }) });
    const safe = reg.listByTags(['safe']);
    expect(safe).toHaveLength(1);
    expect(safe[0]?.name).toBe('a');
  });

  it('unregister removes a tool and its aliases', () => {
    const reg = new ToolRegistry();
    reg.register({ ...okTool, aliases: ['e'] });
    expect(reg.get('e')?.name).toBe('echo');
    expect(reg.unregister('echo')).toBe(true);
    expect(reg.get('e')).toBeUndefined();
    expect(reg.unregister('echo')).toBe(false);
  });

  it('cancels execution when external signal aborts', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'wait', description: 'wait',
      execute: (_input, ctx) =>
        new Promise<{ content: string }>((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => resolve({ content: 'never' }), 1000);
        })
    });
    const ac = new AbortController();
    const promise = reg.invoke('wait', '', { ...baseCtx, signal: ac.signal });
    ac.abort();
    const result = await promise;
    expect(result.error).toBe(true);
  });

  it('resolves an alias to the canonical tool name', () => {
    const reg = new ToolRegistry();
    reg.register({ ...okTool, aliases: ['e', 'say'] });
    expect(reg.get('e')?.name).toBe('echo');
    expect(reg.get('say')?.name).toBe('echo');
  });

  it('rejects alias collisions atomically', () => {
    const reg = new ToolRegistry();
    reg.register({ ...okTool, aliases: ['e'] });
    expect(() => reg.register({
      name: 'e', description: 'collide', execute: () => ({ content: '' })
    })).toThrow();
    expect(() => reg.register({
      name: 'echo2', description: 'x', aliases: ['e'], execute: () => ({ content: '' })
    })).toThrow();
    // Original aliases should remain intact after failed registration.
    expect(reg.get('e')?.name).toBe('echo');
  });

  it('upsert cleans stale aliases', () => {
    const reg = new ToolRegistry();
    reg.register({ ...okTool, aliases: ['e', 'say'] });
    reg.upsert({ ...okTool, aliases: ['e'] });
    expect(reg.get('say')).toBeUndefined();
    expect(reg.get('e')?.name).toBe('echo');
  });

  it('upsert refuses an alias owned by another tool', () => {
    const reg = new ToolRegistry();
    reg.register({ ...okTool, aliases: ['e'] });
    reg.register({
      name: 'other', description: 'other',
      execute: () => ({ content: '' })
    });
    expect(() => reg.upsert({
      name: 'other', description: 'other', aliases: ['e'],
      execute: () => ({ content: '' })
    })).toThrow();
  });

  it('suggest returns the closest tool for typos', () => {
    const reg = new ToolRegistry();
    reg.register({ ...okTool });
    reg.register({
      name: 'memory.save', description: 'save',
      execute: () => ({ content: '' })
    });
    expect(reg.suggest('echoo')).toBe('echo');
    expect(reg.suggest('memry.save')).toBe('memory.save');
    expect(reg.suggest('totally-unrelated')).toBeUndefined();
  });
});
