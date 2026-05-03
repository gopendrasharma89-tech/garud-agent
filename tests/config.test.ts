import { describe, expect, it } from 'vitest';
import { defaultConfig, mergeConfig, validateConfig } from '../src/config.js';

describe('mergeConfig', () => {
  it('merges nested keys without losing defaults', () => {
    const merged = mergeConfig(defaultConfig, {
      agent: { name: 'Custom' } as never
    });
    expect(merged.agent.name).toBe('Custom');
    expect(merged.agent.persona).toBe(defaultConfig.agent.persona);
  });

  it('merges cors and rateLimit independently', () => {
    const merged = mergeConfig(defaultConfig, {
      cors: { enabled: true, origins: ['https://a.test'] },
      rateLimit: { maxRequests: 9 } as never
    });
    expect(merged.cors.enabled).toBe(true);
    expect(merged.cors.origins).toEqual(['https://a.test']);
    expect(merged.rateLimit.maxRequests).toBe(9);
    expect(merged.rateLimit.windowMs).toBe(defaultConfig.rateLimit.windowMs);
  });

  it('replaces plugins array entirely', () => {
    const merged = mergeConfig(defaultConfig, {
      plugins: [{ id: 'p1', module: './x.mjs' }]
    });
    expect(merged.plugins).toHaveLength(1);
  });
});

describe('validateConfig', () => {
  it('returns no issues for the default config', () => {
    expect(validateConfig(defaultConfig)).toEqual([]);
  });

  it('flags out-of-range port', () => {
    const issues = validateConfig({ ...defaultConfig, port: 70_000 });
    expect(issues.some((i) => i.path === 'port')).toBe(true);
  });

  it('flags openai-compatible without keys', () => {
    const issues = validateConfig({
      ...defaultConfig,
      brain: { ...defaultConfig.brain, provider: 'openai-compatible', apiKey: undefined }
    });
    expect(issues.some((i) => i.path === 'brain')).toBe(true);
  });

  it('flags absurd intervals', () => {
    const issues = validateConfig({
      ...defaultConfig,
      scheduler: { ...defaultConfig.scheduler, heartbeatMs: 10 }
    });
    expect(issues.some((i) => i.path === 'scheduler.heartbeatMs')).toBe(true);
  });

  it('flags pairing TTL too low', () => {
    const issues = validateConfig({
      ...defaultConfig,
      pairing: { ...defaultConfig.pairing, codeTtlMs: 100 }
    });
    expect(issues.some((i) => i.path === 'pairing.codeTtlMs')).toBe(true);
  });

  it('flags zero rate limit window', () => {
    const issues = validateConfig({
      ...defaultConfig,
      rateLimit: { ...defaultConfig.rateLimit, windowMs: 0 }
    });
    expect(issues.some((i) => i.path === 'rateLimit.windowMs')).toBe(true);
  });
});
