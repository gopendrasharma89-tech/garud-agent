/** Lowercase + alphanumeric tokenization with stop-word removal. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'may', 'might', 'must', 'shall', 'to', 'of', 'in', 'on', 'at', 'by',
  'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'from', 'up', 'down', 'out', 'off',
  'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 's', 't', 'can', 'just', 'don', 'now', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them'
]);

export function tokenize(text: string, stripStopWords = true): string[] {
  if (!text) return [];
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\uFFFF\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!stripStopWords) return raw;
  return raw.filter((t) => !STOP_WORDS.has(t) && t.length > 1);
}

export function truncate(text: string, max: number, suffix = '…'): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** Match a glob-like pattern with `*` wildcards. Anchored. */
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

/** Stable JSON serialization with sorted keys. */
export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, (_, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(val).sort()) {
        sorted[key] = (val as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return val;
  }, indent);
}

export function ngrams(text: string, n = 3): string[] {
  const lowered = text.toLowerCase();
  if (lowered.length < n) return [lowered];
  const out: string[] = [];
  for (let i = 0; i <= lowered.length - n; i++) {
    out.push(lowered.slice(i, i + n));
  }
  return out;
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Levenshtein distance for "did you mean" suggestions. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Suggest the closest candidate within max distance, or undefined. */
export function suggestClosest(input: string, candidates: string[], maxDistance = 3): string | undefined {
  let best: { name: string; dist: number } | undefined;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d <= maxDistance && (!best || d < best.dist)) best = { name: c, dist: d };
  }
  return best?.name;
}

/** HTML-escape the four dangerous characters for safe embedding into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Simple unified-style line diff between two texts. */
export function lineDiff(a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const x = aLines[i];
    const y = bLines[i];
    if (x === y) {
      if (x !== undefined) out.push(`  ${x}`);
    } else {
      if (x !== undefined) out.push(`- ${x}`);
      if (y !== undefined) out.push(`+ ${y}`);
    }
  }
  return out.join('\n');
}
