/**
 * Self-critique / reflection loop. The reflector applies a critique function
 * to an output, and if the critique flags it, asks a revise function for an
 * improvement. Continues for up to `maxIterations` cycles or until accepted.
 *
 * The critique and revise functions are pluggable — for the deterministic
 * brain we use heuristic critiques; an LLM brain can plug in semantic ones.
 */

export interface ReflectionResult<TOutput> {
  output: TOutput;
  iterations: number;
  accepted: boolean;
  critiques: string[];
}

export interface Reflector<TOutput> {
  /** Returns null when output is acceptable, or a critique string when revision is needed. */
  critique(output: TOutput): Promise<string | null> | string | null;
  /** Produce a revised output given the original and the critique. */
  revise(output: TOutput, critique: string): Promise<TOutput> | TOutput;
}

export interface ReflectionOptions {
  maxIterations?: number;
  /** Stop early if critique repeats verbatim (avoid infinite loop). */
  stopOnRepeat?: boolean;
}

export async function reflectAndRevise<TOutput>(
  initial: TOutput,
  reflector: Reflector<TOutput>,
  opts: ReflectionOptions = {}
): Promise<ReflectionResult<TOutput>> {
  const max = Math.max(1, opts.maxIterations ?? 3);
  const stopOnRepeat = opts.stopOnRepeat ?? true;
  const critiques: string[] = [];
  let current = initial;
  let iterations = 0;
  while (iterations < max) {
    const critique = await reflector.critique(current);
    if (!critique) {
      return { output: current, iterations, accepted: true, critiques };
    }
    if (stopOnRepeat && critiques[critiques.length - 1] === critique) {
      critiques.push(critique);
      return { output: current, iterations, accepted: false, critiques };
    }
    critiques.push(critique);
    current = await reflector.revise(current, critique);
    iterations += 1;
  }
  return { output: current, iterations, accepted: false, critiques };
}

/**
 * Built-in heuristic reflector for plain-text replies. Flags very short
 * responses, error markers, or responses missing punctuation. Useful for
 * the deterministic brain or as a baseline.
 */
export const textHeuristicReflector: Reflector<string> = {
  critique(output: string): string | null {
    const t = (output ?? '').trim();
    if (t.length < 3) return 'response too short';
    if (/(\berror\b|\bundefined\b|\bnull\b)/i.test(t) && t.length < 80) return 'response looks like a raw error';
    if (t.length > 80 && !/[.!?]$/.test(t)) return 'response should end with punctuation';
    return null;
  },
  revise(output: string, critique: string): string {
    if (critique === 'response too short') return (output ?? '') + ' (could you elaborate?)';
    if (critique.includes('punctuation')) return output.replace(/\s+$/, '') + '.';
    if (critique.includes('raw error')) return 'I encountered an issue while processing that. Could you rephrase?';
    return output;
  }
};
