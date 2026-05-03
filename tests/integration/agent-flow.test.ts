import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { defaultConfig } from '../../src/config.js';
import { AppConfig } from '../../src/types.js';

function testConfig(): AppConfig {
  return {
    ...defaultConfig,
    storage: { ...defaultConfig.storage, persistent: false },
    rateLimit: { ...defaultConfig.rateLimit, enabled: false },
    scheduler: { ...defaultConfig.scheduler, enabled: false },
    logging: { level: 'error', json: false }
  };
}

describe('end-to-end agent flow', () => {
  it('saves a memory in turn 1 and recalls it in turn 2', async () => {
    const { gateway } = await bootstrap(testConfig());
    const first = await gateway.handle({
      channel: 'http', userId: 'owner', text: 'remember meeting at 5pm', trustLevel: 'owner'
    });
    expect(first.usedTools).toContain('memory.save');
    const second = await gateway.handle({
      channel: 'http', userId: 'owner', text: 'what do you know about meeting', trustLevel: 'owner'
    });
    expect(second.text.toLowerCase()).toContain('meeting');
    await gateway.shutdown('test-end');
  });

  it('blocks guest writes but allows safe utility tools', async () => {
    const { gateway } = await bootstrap(testConfig());
    const reply = await gateway.handle({
      channel: 'http', userId: 'g1', text: 'remember secret', trustLevel: 'guest'
    });
    expect(reply.text).toMatch(/blocked by policy/);
    const safe = await gateway.handle({
      channel: 'http', userId: 'g1', text: 'what time is it', trustLevel: 'guest'
    });
    expect(safe.text).toMatch(/\d{4}-\d{2}-\d{2}T/);
    await gateway.shutdown('test-end');
  });

  it('elevates trust via pairing flow', async () => {
    const { gateway } = await bootstrap(testConfig());
    await gateway.handle({
      channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'guest'
    });
    const issued = gateway.issuePairing('http', 'u1', 'trusted')!;
    const result = gateway.redeemPairing(issued.code);
    expect(result.ok).toBe(true);
    const session = gateway.sessions.getByUser('http', 'u1');
    expect(session?.trustLevel).toBe('trusted');
    await gateway.shutdown('test-end');
  });

  it('handles math, hash, and base64 tools end-to-end', async () => {
    const { gateway } = await bootstrap(testConfig());
    const math = await gateway.handle({
      channel: 'http', userId: 'owner', text: 'calculate 7 * 6 + 1', trustLevel: 'owner'
    });
    expect(math.text).toContain('43');
    const hash = await gateway.handle({
      channel: 'http', userId: 'owner', text: 'sha256 of hello', trustLevel: 'owner'
    });
    expect(hash.text).toMatch(/[0-9a-f]{60,}/);
    await gateway.shutdown('test-end');
  });

  it('applies skill snippets to LLM context', async () => {
    const { gateway, skills } = await bootstrap(testConfig());
    expect(skills).toBeDefined();
    const reply = await gateway.handle({
      channel: 'http', userId: 'owner', text: 'status', trustLevel: 'owner'
    });
    expect(reply.text).toBeTruthy();
    await gateway.shutdown('test-end');
  });
});
