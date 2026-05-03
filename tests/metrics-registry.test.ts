import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/metrics/registry.js';

describe('MetricsRegistry', () => {
  it('renders an empty counter as zero', () => {
    const reg = new MetricsRegistry();
    reg.counter('garud_test_total', 'A test counter');
    const out = reg.render();
    expect(out).toContain('# TYPE garud_test_total counter');
    expect(out).toContain('garud_test_total 0');
  });

  it('increments counters with labels', () => {
    const reg = new MetricsRegistry();
    reg.counter('garud_test_total', 'A test counter');
    reg.inc('garud_test_total', { kind: 'a' });
    reg.inc('garud_test_total', { kind: 'a' });
    reg.inc('garud_test_total', { kind: 'b' }, 3);
    const out = reg.render();
    expect(out).toContain('garud_test_total{kind="a"} 2');
    expect(out).toContain('garud_test_total{kind="b"} 3');
  });

  it('sets gauge values', () => {
    const reg = new MetricsRegistry();
    reg.gauge('garud_active', 'active count');
    reg.set('garud_active', 7);
    const out = reg.render();
    expect(out).toContain('garud_active 7');
  });

  it('observes histogram values into buckets', () => {
    const reg = new MetricsRegistry();
    reg.histogram('garud_latency_ms', 'latency', [10, 100, 1000]);
    reg.observe('garud_latency_ms', 5);
    reg.observe('garud_latency_ms', 50);
    reg.observe('garud_latency_ms', 5000);
    const out = reg.render();
    expect(out).toContain('garud_latency_ms_bucket{le="10"} 1');
    expect(out).toContain('garud_latency_ms_bucket{le="100"} 2');
    expect(out).toContain('garud_latency_ms_bucket{le="1000"} 2');
    expect(out).toContain('garud_latency_ms_bucket{le="+Inf"} 3');
    expect(out).toContain('garud_latency_ms_count 3');
    expect(out).toContain('garud_latency_ms_sum 5055');
  });

  it('escapes special characters in label values', () => {
    const reg = new MetricsRegistry();
    reg.counter('test', 'help');
    reg.inc('test', { val: 'a"b\\c' });
    const out = reg.render();
    expect(out).toContain('val="a\\"b\\\\c"');
  });

  it('ignores unknown metric names silently', () => {
    const reg = new MetricsRegistry();
    expect(() => reg.inc('nonexistent')).not.toThrow();
    expect(() => reg.set('nonexistent', 1)).not.toThrow();
    expect(() => reg.observe('nonexistent', 1)).not.toThrow();
  });
});
