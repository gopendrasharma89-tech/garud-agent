/**
 * Safe arithmetic expression evaluator.
 * Supports +, -, *, /, %, **, parentheses, and unary minus on numbers.
 */

type TokenKind = 'num' | 'op' | 'lparen' | 'rparen' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

class Lexer {
  private pos = 0;
  constructor(private readonly src: string) {}

  next(): Token {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
    if (this.pos >= this.src.length) return { kind: 'eof', value: '', pos: this.pos };

    const ch = this.src[this.pos]!;
    if (ch === '(') { this.pos++; return { kind: 'lparen', value: '(', pos: this.pos - 1 }; }
    if (ch === ')') { this.pos++; return { kind: 'rparen', value: ')', pos: this.pos - 1 }; }

    if ('+-*/%'.includes(ch)) {
      if (ch === '*' && this.src[this.pos + 1] === '*') {
        this.pos += 2;
        return { kind: 'op', value: '**', pos: this.pos - 2 };
      }
      this.pos++;
      return { kind: 'op', value: ch, pos: this.pos - 1 };
    }

    if (/[0-9.]/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos]!)) {
        this.pos++;
      }
      const value = this.src.slice(start, this.pos);
      return { kind: 'num', value, pos: start };
    }

    throw new Error(`Unexpected character: ${ch}`);
  }
}

class Parser {
  private current: Token;
  constructor(private readonly lexer: Lexer) {
    this.current = lexer.next();
  }

  private eat(kind: TokenKind, value?: string): Token {
    if (this.current.kind !== kind || (value !== undefined && this.current.value !== value)) {
      throw new Error(`Expected ${value ?? kind} at position ${this.current.pos}`);
    }
    const tok = this.current;
    this.current = this.lexer.next();
    return tok;
  }

  parse(): number {
    const result = this.expr();
    if (this.current.kind !== 'eof') {
      throw new Error(`Unexpected token at position ${this.current.pos}`);
    }
    return result;
  }

  private expr(): number {
    let left = this.term();
    while (this.current.kind === 'op' && (this.current.value === '+' || this.current.value === '-')) {
      const op = this.current.value;
      this.eat('op');
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private term(): number {
    let left = this.power();
    while (this.current.kind === 'op' && ['*', '/', '%'].includes(this.current.value)) {
      const op = this.current.value;
      this.eat('op');
      const right = this.power();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Division by zero');
      if (op === '*') left = left * right;
      else if (op === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }

  private power(): number {
    const base = this.unary();
    if (this.current.kind === 'op' && this.current.value === '**') {
      this.eat('op', '**');
      const exp = this.power();
      return base ** exp;
    }
    return base;
  }

  private unary(): number {
    if (this.current.kind === 'op' && (this.current.value === '+' || this.current.value === '-')) {
      const op = this.current.value;
      this.eat('op');
      const value = this.unary();
      return op === '-' ? -value : value;
    }
    return this.primary();
  }

  private primary(): number {
    if (this.current.kind === 'num') {
      const tok = this.eat('num');
      const num = Number(tok.value);
      if (!Number.isFinite(num)) throw new Error(`Invalid number: ${tok.value}`);
      return num;
    }
    if (this.current.kind === 'lparen') {
      this.eat('lparen');
      const value = this.expr();
      this.eat('rparen');
      return value;
    }
    throw new Error(`Unexpected token at position ${this.current.pos}`);
  }
}

export function evaluateExpression(input: string): number {
  if (!input || !input.trim()) throw new Error('Empty expression');
  const cleaned = input.replace(/[^\d+\-*/%()\s.]/g, '').trim();
  if (!cleaned) throw new Error('No arithmetic content');
  const lexer = new Lexer(cleaned);
  const parser = new Parser(lexer);
  return parser.parse();
}
