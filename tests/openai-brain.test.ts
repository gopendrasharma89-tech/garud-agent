import { describe, expect, it, vi } from 'vitest';
import { OpenAiBrain } from '../src/brain/openai-brain.js';
import { Session } from '../src/types.js';

const session: Session = {
  id: 's1', channel: 'http', userId: 'u1', trustLevel: 'owner', role: 'main', agentId: 'main',
  createdAt: 0, updatedAt: 0, messageCount: 0, settings: {}
};

describe('OpenAiBrain', () => {
  it('uses the response content from the API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Hello from LLM' } }]
      })
    } as Response) as unknown as typeof fetch;

    const brain = new OpenAiBrain({
      apiBase: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl
    });

    const reply = await brain.compose({
      input: 'hi', session, memories: [], toolOutputs: []
    });
    expect(reply.text).toBe('Hello from LLM');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the deterministic brain on HTTP errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
      json: async () => ({})
    } as Response) as unknown as typeof fetch;

    const brain = new OpenAiBrain({
      apiBase: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl
    });

    const reply = await brain.compose({
      input: 'hi', session, memories: [], toolOutputs: []
    });
    expect(reply.notes).toContain('llm-fallback');
  });

  it('falls back when content is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '' } }] })
    } as Response) as unknown as typeof fetch;

    const brain = new OpenAiBrain({
      apiBase: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl
    });

    const reply = await brain.compose({
      input: 'hi', session, memories: [], toolOutputs: []
    });
    expect(reply.notes).toContain('llm-fallback');
  });

  it('uses planner from the deterministic fallback', async () => {
    const brain = new OpenAiBrain({
      apiBase: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model'
    });
    const plan = await brain.plan({
      input: 'remember this',
      session,
      availableTools: [],
      recentMemories: []
    });
    expect(plan.toolCalls.some((c) => c.tool === 'memory.save')).toBe(true);
  });

  it('passes external abort signal to fetch', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      receivedSignal = init.signal as AbortSignal;
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] })
      } as Response;
    }) as unknown as typeof fetch;

    const brain = new OpenAiBrain({
      apiBase: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl
    });
    const ac = new AbortController();
    await brain.compose({
      input: 'hi', session, memories: [], toolOutputs: [], signal: ac.signal
    });
    expect(receivedSignal).toBeDefined();
  });

  it('includes skills block in the message payload', async () => {
    let bodySent = '';
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodySent = String(init.body);
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] })
      } as Response;
    }) as unknown as typeof fetch;

    const brain = new OpenAiBrain({
      apiBase: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl
    });
    await brain.compose({
      input: 'hi', session, memories: [], toolOutputs: [],
      skills: [{ name: 'cooking', content: 'use a hot pan' }]
    });
    expect(bodySent).toContain('cooking');
    expect(bodySent).toContain('hot pan');
  });
});
