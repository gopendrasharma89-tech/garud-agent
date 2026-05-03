import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../src/middleware/dashboard.js';

describe('renderDashboard', () => {
  it('renders required HTML structure', () => {
    const html = renderDashboard({
      agent: 'Garud', brain: 'deterministic', version: '0.4.0',
      handled: 5, rateLimited: 0, duplicates: 0, errors: 0,
      sessions: 1, memories: 2, channels: ['http', 'console'], tools: 17
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Garud');
    expect(html).toContain('v0.4.0');
    expect(html).toContain('<code>http</code>');
    expect(html).toContain('17');
  });

  it('shows cache row when supplied', () => {
    const html = renderDashboard({
      agent: 'G', brain: 'b', version: '0.4.0',
      handled: 0, rateLimited: 0, duplicates: 0, errors: 0,
      sessions: 0, memories: 0, channels: [], tools: 0,
      cache: { hits: 3, misses: 7, size: 5, enabled: true }
    });
    expect(html).toContain('Cache');
    expect(html).toContain('3/7 hits/miss');
  });

  it('shows ws row when supplied', () => {
    const html = renderDashboard({
      agent: 'G', brain: 'b', version: '0.4.0',
      handled: 0, rateLimited: 0, duplicates: 0, errors: 0,
      sessions: 0, memories: 0, channels: [], tools: 0,
      ws: 4
    });
    expect(html).toContain('WS clients');
    expect(html).toContain('4');
  });

  it('handles empty channel list gracefully', () => {
    const html = renderDashboard({
      agent: 'G', brain: 'b', version: '0.4.0',
      handled: 0, rateLimited: 0, duplicates: 0, errors: 0,
      sessions: 0, memories: 0, channels: [], tools: 0
    });
    expect(html).toContain('—');
  });
});
