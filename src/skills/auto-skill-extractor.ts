import type { BrainProvider, BrainPlanContext, BrainComposeContext } from '../brain/brain.js';
import type { AgentPlan, AgentReply } from '../types.js';
import type { SkillLibrary } from './skill-library.js';

/**
 * Hermes-style auto-learn decorator. Wraps any `BrainProvider` and, after a
 * compose() call that looks "successful" (non-empty reply, no error markers,
 * minimum length), extracts the (input, output) pair into the SkillLibrary.
 *
 * "Success" is heuristic — we don't have explicit user feedback at this
 * layer — but the library deduplicates on slug so repeated patterns bump
 * `successCount` rather than spamming new skills.
 *
 * Extraction runs asynchronously and is fire-and-forget; failures are
 * swallowed so a learning bug never breaks an agent reply.
 */
export class AutoSkillExtractor implements BrainProvider {
  public readonly name: string;

  constructor(
    private readonly inner: BrainProvider,
    private readonly library: SkillLibrary,
    private readonly opts: {
      /** Minimum reply length to consider extracting. Default 40 chars. */
      minReplyChars?: number;
      /** Max input chars to capture (longer is truncated). Default 1000. */
      maxInputChars?: number;
    } = {}
  ) {
    this.name = inner.name;
  }

  async plan(ctx: BrainPlanContext): Promise<AgentPlan> {
    return Promise.resolve(this.inner.plan(ctx));
  }

  async compose(ctx: BrainComposeContext): Promise<AgentReply> {
    const reply = await Promise.resolve(this.inner.compose(ctx));
    queueMicrotask(() => this.tryExtract(ctx.input, reply.text ?? '').catch(() => { /* swallow */ }));
    return reply;
  }

  private async tryExtract(input: string, output: string): Promise<void> {
    const minLen = this.opts.minReplyChars ?? 40;
    const maxIn = this.opts.maxInputChars ?? 1000;
    if (!output || output.length < minLen) return;
    if (/\b(error|undefined|null|sorry, i can't)\b/i.test(output) && output.length < 200) return;
    const trimmedInput = input.length > maxIn ? input.slice(0, maxIn) : input;
    // Derive a stable slug from the first 6 input words to dedupe similar requests.
    const name = trimmedInput.split(/\s+/).slice(0, 6).join(' ').replace(/[^A-Za-z0-9 _-]/g, '').trim();
    if (!name) return;
    await this.library.extract({
      input: trimmedInput,
      output,
      success: true,
      name,
      when: trimmedInput
    });
  }
}
