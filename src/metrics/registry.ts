/**
 * Minimal Prometheus-style metrics registry. Supports counters, gauges, and
 * histograms with label sets. Designed to be zero-dependency and tiny.
 */

type LabelSet = Record<string, string>;

interface CounterEntry {
  name: string;
  help: string;
  values: Map<string, number>;
}

interface GaugeEntry {
  name: string;
  help: string;
  values: Map<string, number>;
}

interface HistogramEntry {
  name: string;
  help: string;
  buckets: number[];
  values: Map<string, { counts: number[]; sum: number; count: number }>;
}

function labelKey(labels: LabelSet | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: LabelSet | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return '{' + keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? '')}"`).join(',') + '}';
}

export class MetricsRegistry {
  private counters = new Map<string, CounterEntry>();
  private gauges = new Map<string, GaugeEntry>();
  private histograms = new Map<string, HistogramEntry>();

  counter(name: string, help: string): void {
    if (!this.counters.has(name)) {
      this.counters.set(name, { name, help, values: new Map() });
    }
  }

  gauge(name: string, help: string): void {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, { name, help, values: new Map() });
    }
  }

  histogram(name: string, help: string, buckets: number[]): void {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, {
        name, help,
        buckets: [...buckets].sort((a, b) => a - b),
        values: new Map()
      });
    }
  }

  inc(name: string, labels?: LabelSet, by = 1): void {
    const entry = this.counters.get(name);
    if (!entry) return;
    const key = labelKey(labels);
    entry.values.set(key, (entry.values.get(key) ?? 0) + by);
  }

  set(name: string, value: number, labels?: LabelSet): void {
    const entry = this.gauges.get(name);
    if (!entry) return;
    entry.values.set(labelKey(labels), value);
  }

  observe(name: string, value: number, labels?: LabelSet): void {
    const entry = this.histograms.get(name);
    if (!entry) return;
    const key = labelKey(labels);
    let bucket = entry.values.get(key);
    if (!bucket) {
      bucket = { counts: new Array(entry.buckets.length).fill(0), sum: 0, count: 0 };
      entry.values.set(key, bucket);
    }
    bucket.sum += value;
    bucket.count += 1;
    for (let i = 0; i < entry.buckets.length; i++) {
      if (value <= entry.buckets[i]!) bucket.counts[i] = (bucket.counts[i] ?? 0) + 1;
    }
  }

  render(): string {
    const lines: string[] = [];
    for (const c of this.counters.values()) {
      lines.push(`# HELP ${c.name} ${c.help}`);
      lines.push(`# TYPE ${c.name} counter`);
      if (c.values.size === 0) {
        lines.push(`${c.name} 0`);
      } else {
        for (const [key, value] of c.values) {
          const labels = key ? this.parseKey(key) : undefined;
          lines.push(`${c.name}${formatLabels(labels)} ${value}`);
        }
      }
    }
    for (const g of this.gauges.values()) {
      lines.push(`# HELP ${g.name} ${g.help}`);
      lines.push(`# TYPE ${g.name} gauge`);
      if (g.values.size === 0) {
        lines.push(`${g.name} 0`);
      } else {
        for (const [key, value] of g.values) {
          const labels = key ? this.parseKey(key) : undefined;
          lines.push(`${g.name}${formatLabels(labels)} ${value}`);
        }
      }
    }
    for (const h of this.histograms.values()) {
      lines.push(`# HELP ${h.name} ${h.help}`);
      lines.push(`# TYPE ${h.name} histogram`);
      for (const [key, bucket] of h.values) {
        const baseLabels = key ? this.parseKey(key) : {};
        for (let i = 0; i < h.buckets.length; i++) {
          lines.push(
            `${h.name}_bucket${formatLabels({ ...baseLabels, le: String(h.buckets[i]) })} ${bucket.counts[i] ?? 0}`
          );
        }
        lines.push(`${h.name}_bucket${formatLabels({ ...baseLabels, le: '+Inf' })} ${bucket.count}`);
        lines.push(`${h.name}_sum${formatLabels(baseLabels)} ${bucket.sum}`);
        lines.push(`${h.name}_count${formatLabels(baseLabels)} ${bucket.count}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  private parseKey(key: string): LabelSet {
    const out: LabelSet = {};
    for (const part of key.split(',')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      out[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return out;
  }
}
