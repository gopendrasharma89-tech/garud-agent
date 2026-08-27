import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GARUD_BUILD, GARUD_VERSION } from '../version.js';

export interface OnboardingOptions {
  dir: string;
  name?: string;
  persona?: string;
  force?: boolean;
}

export interface OnboardingResult {
  dir: string;
  created: string[];
  skipped: string[];
  configPath: string;
}

function configTemplate(name: string, dir: string, persona?: string): string {
  return JSON.stringify({
    agent: {
      name,
      persona: persona ?? `You are ${name}, a concise local-first AI assistant. You live on this machine, remember what matters, and never leak secrets.`
    },
    storage: { workspaceDir: dir, persistent: true },
    dmPolicy: { defaultPolicy: 'pairing' },
    commands: { enabled: true },
    queue: { mode: 'queue', maxDepth: 8 },
    routing: { bindings: [] }
  }, null, 2) + '\n';
}

function soulTemplate(name: string): string {
  return `# SOUL.md — who ${name} is

## Core truths
- Be genuinely useful, not performatively busy. Skip filler; deliver results.
- Have opinions. When asked to choose, choose — hedging is a tax on the user.
- Be resourceful before asking. Check memory, files, and tools first.
- Private things stay private. Never exfiltrate workspace contents.

## Boundaries
- Ask before destructive or expensive actions (deletes, purchases, mass messages).
- Never send half-finished work to strangers; drafts go to the owner first.
- When trust is "guest", stay read-only and polite.

## Vibe
Concise. Warm. A little wry. Uses the user's language (Hinglish welcome).
`;
}

function identityTemplate(name: string): string {
  return `# IDENTITY.md — ${name}

- **Name:** ${name}
- **Creature:** Garuda — the eagle that carries messages between worlds
- **Version:** ${GARUD_VERSION} "${GARUD_BUILD.codename}"
- **Emoji:** 🦅
- **Purpose:** one gateway, every channel — a personal assistant that lives on
  your machine, speaks WhatsApp/Telegram/WebChat, and answers to you alone.
`;
}

function agentsTemplate(name: string): string {
  return `# AGENTS.md — operating manual for ${name}

## Every session
1. Read SOUL.md (who you are) and USER.md (who you serve).
2. Check MEMORY.md for long-term facts; logs/ for recent daily context.
3. Answer in the user's language and tone.

## Memory discipline
- Important fact learned → append to MEMORY.md via longterm tools.
- Daily events → logs/YYYY-MM-DD.md happens automatically; review at heartbeat.

## Safety rails
- Guests get read-only tools; mutations need trusted+.
- Pairing codes gate new users (dmPolicy: pairing).
- Never echo secrets, tokens, or file paths outside the workspace.
`;
}

function userTemplate(): string {
  return `# USER.md — who you serve

- **Name:** (fill in)
- **Timezone:** (fill in)
- **Channels:** telegram / webchat / http
- **Preferences:** short answers first, details on request
- **Do not:** ping after midnight; auto-send anything to third parties
`;
}

function heartbeatTemplate(): string {
  return `# HEARTBEAT.md — ambient duties

### every 30m
- scan logs/ for unanswered questions; summarize anything urgent

### daily at 09:00
- one-line plan for the day into logs/

### daily at 21:30
- reflect: append 3-bullet summary of today to MEMORY.md
`;
}

function memoryTemplate(name: string): string {
  return `# MEMORY.md — ${name}'s long-term memory

## Facts
- (none yet — I will append what matters here)

## Preferences
- (learned preferences land here)
`;
}

/**
 * OpenClaw-style onboarding: seeds a complete workspace (config + soul files)
 * with safe defaults — dmPolicy "pairing" so strangers can't talk to your
 * agent until you approve them. Existing files are never overwritten unless
 * force is set.
 */
export async function runOnboarding(options: OnboardingOptions): Promise<OnboardingResult> {
  const name = options.name?.trim() || 'Garud';
  const dir = path.resolve(options.dir);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, 'skills'), { recursive: true });
  await fs.mkdir(path.join(dir, 'logs'), { recursive: true });

  const files: Array<{ file: string; content: string }> = [
    { file: 'garud.json', content: configTemplate(name, dir, options.persona) },
    { file: 'SOUL.md', content: soulTemplate(name) },
    { file: 'IDENTITY.md', content: identityTemplate(name) },
    { file: 'AGENTS.md', content: agentsTemplate(name) },
    { file: 'USER.md', content: userTemplate() },
    { file: 'HEARTBEAT.md', content: heartbeatTemplate() },
    { file: 'MEMORY.md', content: memoryTemplate(name) }
  ];

  const created: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const target = path.join(dir, f.file);
    const exists = await fs.stat(target).then(() => true).catch(() => false);
    if (exists && !options.force) {
      skipped.push(f.file);
      continue;
    }
    await fs.writeFile(target, f.content, 'utf8');
    created.push(f.file);
  }
  return { dir, created, skipped, configPath: path.join(dir, 'garud.json') };
}
