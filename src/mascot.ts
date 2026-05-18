/**
 * Garud Agent mascot — "Skyforge", a stylized falcon/eagle ASCII illustration.
 * Designed to be readable in any terminal (no Unicode-only glyphs) and to
 * render gracefully without ANSI when stdout is not a TTY.
 *
 * Used by `garud --help`, `garud doctor`, and the CLI welcome banner. The
 * mascot deliberately uses neutral imagery so the project reads as globally
 * accessible while keeping the "soaring falcon" identity of Garud.
 */
const ESC = '\x1b[';
function paint(text: string, color: string, useColor: boolean): string {
  return useColor ? `${ESC}${color}m${text}${ESC}0m` : text;
}

export interface MascotOptions {
  /** When true, emit ANSI color codes. Defaults to process.stdout.isTTY. */
  color?: boolean;
  /** Show the tagline under the art. Default true. */
  tagline?: boolean;
}

/** Detect whether color output is appropriate. Honors NO_COLOR per the spec at https://no-color.org. */
function shouldUseColor(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  if (typeof process !== 'undefined' && process.env && process.env.NO_COLOR !== undefined) return false;
  return Boolean(process.stdout && process.stdout.isTTY);
}

/** Returns the Skyforge mascot as a multi-line string. */
export function mascot(opts: MascotOptions = {}): string {
  const useColor = shouldUseColor(opts.color);
  const tagline = opts.tagline ?? true;

  const wing = (s: string) => paint(s, '36', useColor);     // cyan
  const beak = (s: string) => paint(s, '33;1', useColor);   // bright yellow
  const eye  = (s: string) => paint(s, '31;1', useColor);   // bright red
  const body = (s: string) => paint(s, '37', useColor);     // white/grey
  const tag  = (s: string) => paint(s, '90', useColor);     // dim

  const art = [
    `        ${wing('___')}                          ${wing('___')}`,
    `       ${wing('/   \\')}    ${beak('___    ___')}    ${wing('/   \\')}`,
    `      ${wing('|     \\__/   \\__/   \\__/')}     ${wing('|')}`,
    `      ${wing(' \\__')}   ${body('//')}${eye('O')}${body('  ')}${beak('<')}${body('  ')}${eye('O')}${body('\\\\')}   ${wing('__/')}`,
    `         ${wing('\\__')}${body('\\____/')}${wing('__/')}`,
    `              ${body('|||')}`,
    `             ${body('/   \\')}`,
    `            ${body('GARUD')}`
  ].join('\n');

  if (!tagline) return art;
  return art + '\n' + tag('   a local-first, policy-aware agent gateway');
}

/** One-line compact mascot for log prefixes. */
export function mascotInline(opts: MascotOptions = {}): string {
  const useColor = shouldUseColor(opts.color);
  return paint('~< GARUD >~', '36;1', useColor);
}
