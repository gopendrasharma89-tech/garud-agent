import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../src/tools/math-eval.js';

describe('evaluateExpression', () => {
  it('evaluates simple arithmetic', () => {
    expect(evaluateExpression('2 + 3')).toBe(5);
    expect(evaluateExpression('10 - 4')).toBe(6);
    expect(evaluateExpression('6 * 7')).toBe(42);
    expect(evaluateExpression('20 / 4')).toBe(5);
    expect(evaluateExpression('17 % 5')).toBe(2);
  });

  it('respects operator precedence', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateExpression('2 ** 3 ** 2')).toBe(512);
  });

  it('handles unary minus', () => {
    expect(evaluateExpression('-5 + 2')).toBe(-3);
    expect(evaluateExpression('-(2 + 3)')).toBe(-5);
  });

  it('rejects empty input', () => {
    expect(() => evaluateExpression('')).toThrow();
    expect(() => evaluateExpression('   ')).toThrow();
  });

  it('rejects division by zero', () => {
    expect(() => evaluateExpression('5 / 0')).toThrow(/zero/);
    expect(() => evaluateExpression('5 % 0')).toThrow(/zero/);
  });

  it('strips unsafe alphabetic characters but still computes', () => {
    expect(evaluateExpression('2 + alert(1) * 3')).toBe(5);
  });

  it('rejects expressions that become empty after sanitization', () => {
    expect(() => evaluateExpression('alert(hello)')).toThrow();
  });

  it('handles decimals', () => {
    expect(evaluateExpression('1.5 + 2.25')).toBe(3.75);
  });

  it('handles deeply nested expressions', () => {
    expect(evaluateExpression('((1 + 2) * (3 + 4)) - 5')).toBe(16);
  });

  it('rejects unbalanced parens', () => {
    expect(() => evaluateExpression('(1 + 2')).toThrow();
  });
});
