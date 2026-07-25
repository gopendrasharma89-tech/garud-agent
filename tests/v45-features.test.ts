import { describe, expect, it } from 'vitest';
import { GARUD_VERSION, GARUD_BUILD } from '../src/version.js';
import { extractJsonObject } from '../src/utils/json-extract.js';
import { OpenAiBrain, sanitizeAgentPlan } from '../src/brain/openai-brain.js';
import { LlmPlanner, sanitizeSubTasks } from '../src/planning/llm-planner.js';
import { buildPlan } from '../src/planning/planner.js';
import { WorkspaceFiles } from '../src/workspace/workspace-files.js';
import type { Session, ToolDefinition } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const session: Session = {
  id: 'sess-v45',
  userId: 'ritik',
  channel: 'test',
  trustLevel: 'owner',
  agentId: 'main',
  createdAt: Date.now(),
  lastSeenAt: Date.now()
} as unknown as Session;

const tools = [
  { name: 'time.now', description: 'Current time', execute: async () => ({ content: '' }) },
  { name: 'math.eval', description: 'Evaluate math', execute: async () => ({ content: '' }) }
] as unknown as ToolDefinition[];

function llmResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('v4.5.0 "Stratocumulus" — LLM-driven planning', () => {
  it('reports version 4.5.0 Stratocumulus', () => {
    expect(GARUD_VERSION).toBe('4.5.0');
    expect(GARUD_BUILD.codename).toBe('Stratocumulus');
  });

  describe('extractJsonObject', () => {
    it('parses bare JSON', () => {
      expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    });
    it('parses fenced JSON', () => {
      expect(extractJsonObject('```json\n{"a": [1,2]}\n```')).toEqual({ a: [1, 2] });
    });
    it('parses JSON embedded in prose with braces inside strings', () => {
      const text = 'Sure! Here is the plan: {"summary":"a {tricky} one","toolCalls":[]} hope it helps';
      expect(extractJsonObject(text)).toEqual({ summary: 'a {tricky} one', toolCalls: [] });
    });
    it('parses top-level arrays', () => {
      expect(extractJsonObject('steps: [{"id":"s1"}] done')).toEqual([{ id: 's1' }]);
    });
    it('returns undefined for garbage', () => {
      expect(extractJsonObject('no json here')).toBeUndefined();
      expect(extractJsonObject('{broken')).toBeUndefined();
      expect(extractJsonObject('')).toBeUndefined();
    });
  });

  describe('sanitizeAgentPlan', () => {
    it('filters unknown tools, coerces inputs, caps counts', () => {
      const plan = sanitizeAgentPlan({
        summary: 'do it',
        memoryQueries: ['q1', 42, 'q2', 'q3', 'q4'],
        toolCalls: [
          { tool: 'time.now', input: '' },
          { tool: 'evil.tool', input: 'x' },
          { tool: 'math.eval', input: { expr: '1+1' } }
        ]
      }, ['time.now', 'math.eval'], 6);
      expect(plan).toBeDefined();
      expect(plan!.summary).toBe('do it');
      expect(plan!.memoryQueries).toEqual(['q1', 'q2', 'q3']);
      expect(plan!.toolCalls).toEqual([
        { tool: 'time.now', input: '' },
        { tool: 'math.eval', input: '{"expr":"1+1"}' }
      ]);
    });
    it('rejects non-object shapes', () => {
      expect(sanitizeAgentPlan('nope', [], 6)).toBeUndefined();
      expect(sanitizeAgentPlan([1, 2], [], 6)).toBeUndefined();
      expect(sanitizeAgentPlan(undefined, [], 6)).toBeUndefined();
    });
  });

  describe('OpenAiBrain.plan', () => {
    const base = { apiBase: 'https://llm.test/v1', apiKey: 'k', model: 'm' };

    it('uses the LLM to plan tool calls when planningMode=llm', async () => {
      let called = 0;
      const brain = new OpenAiBrain({
        ...base,
        planningMode: 'llm',
        fetchImpl: (async () => {
          called++;
          return llmResponse('{"summary":"check time","memoryQueries":["time"],"toolCalls":[{"tool":"time.now","input":""},{"tool":"bogus.tool","input":""}]}');
        }) as typeof fetch
      });
      const plan = await brain.plan({ input: 'what time is it?', session, availableTools: tools, recentMemories: [] });
      expect(called).toBe(1);
      expect(plan.summary).toBe('check time');
      expect(plan.toolCalls).toEqual([{ tool: 'time.now', input: '' }]);
      expect(plan.memoryQueries).toEqual(['time']);
    });

    it('stays deterministic (no network) by default', async () => {
      let called = 0;
      const brain = new OpenAiBrain({
        ...base,
        fetchImpl: (async () => { called++; return llmResponse('{}'); }) as typeof fetch
      });
      const plan = await brain.plan({ input: 'what time is it now?', session, availableTools: tools, recentMemories: [] });
      expect(called).toBe(0);
      expect(plan.summary).toBe('deterministic-plan');
    });

    it('falls back to the deterministic planner on LLM failure', async () => {
      const brain = new OpenAiBrain({
        ...base,
        planningMode: 'llm',
        fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch
      });
      const plan = await brain.plan({ input: 'what time is it now?', session, availableTools: tools, recentMemories: [] });
      expect(plan.summary).toContain('llm-plan-fallback');
      expect(plan.toolCalls.some((c) => c.tool === 'time.now')).toBe(true);
    });

    it('falls back when the LLM emits garbage', async () => {
      const brain = new OpenAiBrain({
        ...base,
        planningMode: 'llm',
        fetchImpl: (async () => llmResponse('sorry, I cannot help with that')) as typeof fetch
      });
      const plan = await brain.plan({ input: 'calculate 2+2', session, availableTools: tools, recentMemories: [] });
      expect(plan.summary).toContain('llm-plan-fallback');
    });

    it('completeText returns raw model text and throws on HTTP errors', async () => {
      const ok = new OpenAiBrain({ ...base, fetchImpl: (async () => llmResponse('hello!')) as typeof fetch });
      await expect(ok.completeText('hi')).resolves.toBe('hello!');
      const bad = new OpenAiBrain({ ...base, fetchImpl: (async () => new Response('x', { status: 503 })) as typeof fetch });
      await expect(bad.completeText('hi')).rejects.toThrow();
    });
  });

  describe('LlmPlanner', () => {
    it('parses fenced step lists and sanitizes deps/hints', async () => {
      const planner = new LlmPlanner(async () => '```json\n{"steps":[' +
        '{"id":"a","description":"fetch data","toolHints":["http.fetch","nope.tool"]},' +
        '{"id":"b","description":"summarize","dependsOn":["a","ghost"]}' +
        ']}\n```');
      const steps = await planner.plan('fetch and summarize', { availableTools: ['http.fetch'] });
      expect(steps).toEqual([
        { id: 's1', description: 'fetch data', toolHints: ['http.fetch'] },
        { id: 's2', description: 'summarize', dependsOn: ['s1'] }
      ]);
    });

    it('falls back to the heuristic planner on garbage output', async () => {
      const planner = new LlmPlanner(async () => 'i refuse');
      const steps = await planner.plan('fetch the data and then summarize it');
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps[0].id).toBe('s1');
    });

    it('falls back when the completion function throws', async () => {
      const planner = new LlmPlanner(async () => { throw new Error('down'); });
      const steps = await planner.plan('do one thing');
      expect(steps.length).toBeGreaterThanOrEqual(1);
    });

    it('clamps to maxSteps and drops forward/self dependencies', () => {
      const steps = sanitizeSubTasks({ steps: [
        { description: 'one', dependsOn: ['s2'] },
        { description: 'two', dependsOn: ['s2'] },
        { description: 'three' }
      ] }, { maxSteps: 2 });
      expect(steps).toEqual([
        { id: 's1', description: 'one' },
        { id: 's2', description: 'two' }
      ]);
    });

    it('works through buildPlan with an async strategy', async () => {
      const planner = new LlmPlanner(async () => '{"steps":[{"description":"solo step"}]}');
      const plan = await buildPlan('goal', planner);
      expect(plan.goal).toBe('goal');
      expect(plan.steps).toEqual([{ id: 's1', description: 'solo step' }]);
    });
  });

  describe('workspace defaults', () => {
    it('DEFAULT_IDENTITY tracks the live version instead of a stale pin', async () => {
      const ws = new WorkspaceFiles(mkdtempSync(join(tmpdir(), 'garud-ws-')));
      const identity = await ws.readIdentity();
      expect(identity).toContain(GARUD_VERSION);
      expect(identity).toContain(GARUD_BUILD.codename);
      expect(identity).not.toContain('3.5.0');
    });
    it('DEFAULT_SOUL documents the planning behaviour', async () => {
      const ws = new WorkspaceFiles(mkdtempSync(join(tmpdir(), 'garud-ws-')));
      const soul = await ws.readSoul();
      expect(soul).toContain('GARUD_LLM_PLANNING');
    });
  });
});
