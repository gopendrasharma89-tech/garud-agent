import { describe, expect, it } from 'vitest';
import {
  escapeHtml, jaccard, levenshtein, lineDiff, matchPattern, ngrams,
  stableStringify, suggestClosest, tokenize, truncate
} from '../src/utils/text.js';

describe('tokenize', () => {
  it('lowercases and removes punctuation', () => {
    const tokens = tokenize('Hello, World!');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
  });

  it('removes stop words by default', () => {
    const tokens = tokenize('the quick brown fox is here');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).toContain('quick');
  });

  it('keeps stop words when asked', () => {
    const tokens = tokenize('the cat', false);
    expect(tokens).toContain('the');
  });

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('truncates long strings with suffix', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
  });

  it('uses a custom suffix', () => {
    expect(truncate('hello world', 8, '...')).toBe('hello...');
  });
});

describe('matchPattern', () => {
  it('matches exact strings', () => {
    expect(matchPattern('memory.save', 'memory.save')).toBe(true);
  });

  it('matches wildcards', () => {
    expect(matchPattern('memory.*', 'memory.save')).toBe(true);
    expect(matchPattern('memory.*', 'http.fetch')).toBe(false);
  });

  it('matches all with single asterisk', () => {
    expect(matchPattern('*', 'anything')).toBe(true);
  });

  it('escapes regex special characters in patterns', () => {
    expect(matchPattern('a.b', 'a.b')).toBe(true);
    expect(matchPattern('a.b', 'aXb')).toBe(false);
  });
});

describe('stableStringify', () => {
  it('sorts keys deterministically', () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[\n  3,\n  1,\n  2\n]');
  });

  it('honours custom indent', () => {
    expect(stableStringify({ a: 1 }, 0)).toBe('{"a":1}');
  });
});

describe('ngrams + jaccard', () => {
  it('produces overlapping char ngrams', () => {
    expect(ngrams('hello', 3)).toEqual(['hel', 'ell', 'llo']);
  });

  it('jaccard returns 1 for identical sets', () => {
    expect(jaccard(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(1);
  });

  it('jaccard returns 0 for disjoint sets', () => {
    expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
  });
});

describe('levenshtein + suggestClosest', () => {
  it('measures simple edit distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('suggestClosest finds nearest within distance', () => {
    expect(suggestClosest('echoo', ['echo', 'memory'])).toBe('echo');
    expect(suggestClosest('xyz', ['echo'])).toBeUndefined();
  });
});

describe('escapeHtml', () => {
  it('escapes the dangerous characters', () => {
    expect(escapeHtml('<a href="x">&\'</a>'))
      .toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('lineDiff', () => {
  it('marks added and removed lines', () => {
    const out = lineDiff('a\nb\nc', 'a\nx\nc');
    expect(out).toContain('- b');
    expect(out).toContain('+ x');
    expect(out).toContain('  a');
  });
});
