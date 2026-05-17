#!/usr/bin/env node
import readline from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../bootstrap.js';
import { defaultConfig, loadConfigFile, mergeConfig, validateConfig } from '../config.js';
import { TrustLevel } from '../types.js';
import { GARUD_VERSION } from '../version.js';
import { mascot } from '../mascot.js';

const HELP = `Garud Agent CLI v3.0

Usage:
  garud chat   [--user <id>] [--trust <level>] [--agent <id>] <text...>
  garud send   --channel <name> --user <id> --text <msg> [--trust <level>]
  garud repl   [--user <id>] [--trust <level>]
  garud sessions
  garud history --session <id> [--limit 50]
  garud memories --session <id> [--query <q>] [--fuzzy]
  garud memories search --query <q> [--limit 10]
  garud tools  [--tag <tag>]
  garud audit  [--limit 50] [--session <id>] [--kind <kind>] [--request <id>]
  garud stats
  garud cache  show | clear
  garud quotas show
  garud metrics
  garud doctor
  garud trust  --channel <name> --user <id> --level <trust>
  garud pair   issue --channel <name> --user <id> --level <trust>
  garud pair   redeem --code <code>
  garud pair   revoke --channel <name> --user <id>
  garud snapshot [--name <label>] [--gzip]
  garud restore  --name <label>
  garud export   [--out <file>]
  garud import   --in <file>
  garud config   show | validate
  garud version
  garud help
`;

interface ParsedArgs {
  command: string;
  sub?: string;
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  const compoundCommands = ['pair', 'config', 'cache', 'memories', 'quotas'];
  const isCompound = compoundCommands.includes(command);
  const subRaw = isCompound ? args[1] : undefined;
  const sub = subRaw && !subRaw.startsWith('--') ? subRaw : undefined;
  const start = isCompound && sub ? 2 : 1;
  for (let i = start; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = 'true';
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, sub, flags, positional };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const fileConfig = await loadConfigFile().catch(() => ({}));
  const config = mergeConfig(defaultConfig, fileConfig);

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    process.stdout.write(mascot() + '\n\n' + HELP);
    return;
  }
  if (args.command === 'mascot') {
    process.stdout.write(mascot() + '\n');
    return;
  }
  if (args.command === 'version') {
    process.stdout.write(`garud-agent ${GARUD_VERSION}\n`);
    return;
  }
  if (args.command === 'config') {
    if (args.sub === 'show') {
      process.stdout.write(JSON.stringify(config, null, 2) + '\n');
      return;
    }
    if (args.sub === 'validate') {
      const issues = validateConfig(config);
      if (!issues.length) {
        process.stdout.write('config OK\n');
        return;
      }
      for (const i of issues) process.stderr.write(`${i.path}: ${i.message}\n`);
      process.exit(1);
    }
  }

  const issues = validateConfig(config);
  if (issues.length) {
    for (const i of issues) process.stderr.write(`config issue: ${i.path}: ${i.message}\n`);
    process.exit(2);
  }

  const { gateway, audit, tools, store, cache, quotas, conversation, metrics } = await bootstrap(config);

  switch (args.command) {
    case 'chat': {
      const text = args.positional.join(' ').trim();
      if (!text) {
        process.stderr.write('chat requires a message\n');
        process.exit(2);
      }
      const reply = await gateway.handle({
        channel: 'http',
        userId: args.flags.user ?? 'cli',
        text,
        trustLevel: (args.flags.trust as TrustLevel) ?? 'owner',
        agentId: args.flags.agent
      });
      process.stdout.write(reply.text + '\n');
      break;
    }

    case 'repl': {
      const userId = args.flags.user ?? 'cli';
      const trust = (args.flags.trust as TrustLevel) ?? 'owner';
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'garud> ' });
      process.stdout.write(`REPL ready. Trust=${trust}, user=${userId}. Type /exit to quit.\n`);
      rl.prompt();
      rl.on('line', async (line) => {
        const text = line.trim();
        if (!text) { rl.prompt(); return; }
        if (text === '/exit' || text === '/quit') { rl.close(); return; }
        if (text === '/help') {
          process.stdout.write('  /exit       quit REPL\n  /stats      show gateway stats\n  /memories   list memories for this session\n  /history    show recent turns\n  /clear      clear screen\n');
          rl.prompt();
          return;
        }
        if (text === '/stats') {
          process.stdout.write(JSON.stringify(gateway.getStats(), null, 2) + '\n');
          rl.prompt();
          return;
        }
        if (text === '/clear') {
          process.stdout.write('\x1b[2J\x1b[H');
          rl.prompt();
          return;
        }
        if (text === '/history') {
          const session = gateway.sessions.getByUser('http', userId);
          if (!session) {
            process.stdout.write('no session yet\n');
          } else {
            const turns = conversation?.list(session.id, 10) ?? [];
            for (const t of turns) {
              process.stdout.write(`  > ${t.input}\n  < ${t.reply.slice(0, 120)}\n`);
            }
            if (!turns.length) process.stdout.write('  (none)\n');
          }
          rl.prompt();
          return;
        }
        if (text === '/memories') {
          const session = gateway.sessions.getByUser('http', userId);
          if (!session) {
            process.stdout.write('no session yet\n');
          } else {
            const list = gateway.memories.list(session.id);
            for (const m of list) process.stdout.write(`  ${m.id.slice(0, 8)}  ${m.text}\n`);
            if (!list.length) process.stdout.write('  (none)\n');
          }
          rl.prompt();
          return;
        }
        try {
          const reply = await gateway.handle({ channel: 'http', userId, text, trustLevel: trust });
          process.stdout.write(reply.text + '\n');
        } catch (error) {
          process.stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        rl.prompt();
      });
      await new Promise<void>((resolve) => rl.on('close', resolve));
      break;
    }

    case 'send': {
      const channel = args.flags.channel;
      const userId = args.flags.user;
      const text = args.flags.text;
      if (!channel || !userId || !text) {
        process.stderr.write('send requires --channel, --user, --text\n');
        process.exit(2);
      }
      if (!gateway.channels.has(channel)) {
        process.stderr.write(`unknown channel: ${channel}\n`);
        process.exit(3);
      }
      const reply = await gateway.handle({
        channel, userId, text,
        trustLevel: (args.flags.trust as TrustLevel) ?? 'guest'
      });
      process.stdout.write(JSON.stringify(reply, null, 2) + '\n');
      break;
    }

    case 'sessions': {
      const list = gateway.sessions.list();
      if (!list.length) { process.stdout.write('no sessions\n'); break; }
      for (const s of list) {
        process.stdout.write(
          `${s.id.slice(0, 8)}  ${s.channel}/${s.userId}  agent=${s.agentId}  trust=${s.trustLevel}  msgs=${s.messageCount}\n`
        );
      }
      break;
    }

    case 'history': {
      const sid = args.flags.session;
      if (!sid) { process.stderr.write('history requires --session\n'); process.exit(2); }
      const limit = Math.max(1, Math.min(200, Number(args.flags.limit ?? 50)));
      const turns = conversation?.list(sid, limit) ?? [];
      if (!turns.length) { process.stdout.write('no turns\n'); break; }
      for (const t of turns) {
        process.stdout.write(`[${new Date(t.ts).toISOString()}] req=${t.requestId ?? '-'} tools=${t.toolsUsed.join(',') || '-'}\n`);
        process.stdout.write(`  > ${t.input}\n  < ${t.reply.slice(0, 200)}\n`);
      }
      break;
    }

    case 'memories': {
      if (args.sub === 'search') {
        const query = args.flags.query;
        if (!query) { process.stderr.write('memories search requires --query\n'); process.exit(2); }
        const limit = Math.max(1, Math.min(50, Number(args.flags.limit ?? 10)));
        const results = gateway.memories.searchAll(query, limit, { fuzzy: true });
        for (const r of results) {
          process.stdout.write(`${r.memory.id.slice(0, 8)}  score=${r.score.toFixed(2)}  ${r.memory.text}\n`);
        }
        if (!results.length) process.stdout.write('no hits\n');
        break;
      }
      const sessionId = args.flags.session;
      if (!sessionId) {
        process.stderr.write('memories requires --session, or use `memories search --query ...`\n');
        process.exit(2);
      }
      if (args.flags.query) {
        const fuzzy = args.flags.fuzzy === 'true';
        const results = gateway.memories.searchWithScores(sessionId, args.flags.query, { limit: 10, fuzzy });
        for (const r of results) {
          process.stdout.write(`${r.memory.id.slice(0, 8)}  score=${r.score.toFixed(2)}  ${r.memory.text}\n`);
        }
        break;
      }
      const items = gateway.memories.list(sessionId).sort((a, b) => b.createdAt - a.createdAt);
      if (!items.length) { process.stdout.write('no memories\n'); break; }
      for (const m of items) {
        const pin = m.pinned ? ' 📌' : '';
        const ttl = m.expiresAt ? ` exp=${new Date(m.expiresAt).toISOString()}` : '';
        process.stdout.write(`${m.id.slice(0, 8)}  imp=${m.importance.toFixed(2)}${pin}${ttl}  ${m.text}\n`);
      }
      break;
    }

    case 'tools': {
      const tagFilter = args.flags.tag ? [args.flags.tag] : undefined;
      const list = tagFilter ? tools.listByTags(tagFilter) : tools.list();
      for (const t of list) {
        const tags = t.tags?.join(',') ?? '';
        const aliases = t.aliases?.length ? ` (aliases: ${t.aliases.join(', ')})` : '';
        const quota = t.dailyQuota ? ` [quota=${t.dailyQuota}]` : '';
        process.stdout.write(`${t.name.padEnd(20)}  [${tags}]  ${t.description}${aliases}${quota}\n`);
      }
      break;
    }

    case 'audit': {
      const limit = Math.max(1, Math.min(500, Number(args.flags.limit ?? 50)));
      const sink = audit.getInMemorySink();
      const entries = sink?.list({
        limit,
        sessionId: args.flags.session,
        requestId: args.flags.request,
        kind: args.flags.kind as never
      }) ?? [];
      for (const e of entries) process.stdout.write(JSON.stringify(e) + '\n');
      break;
    }

    case 'stats': {
      const stats = gateway.getStats();
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
      break;
    }

    case 'cache': {
      if (!cache) { process.stdout.write('cache disabled\n'); break; }
      if (args.sub === 'clear') {
        cache.clear();
        process.stdout.write('cache cleared\n');
        break;
      }
      process.stdout.write(JSON.stringify(cache.stats(), null, 2) + '\n');
      break;
    }

    case 'quotas': {
      if (!quotas) { process.stdout.write('quotas disabled\n'); break; }
      process.stdout.write(JSON.stringify({ size: quotas.size() }, null, 2) + '\n');
      break;
    }

    case 'metrics': {
      if (!metrics) { process.stdout.write('metrics disabled\n'); break; }
      gateway.refreshGauges();
      process.stdout.write(metrics.render());
      break;
    }

    case 'doctor': {
      const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
      checks.push({ name: 'workspace dir', ok: !!config.storage.workspaceDir, detail: config.storage.workspaceDir });
      checks.push({ name: 'persistence', ok: config.storage.persistent });
      checks.push({ name: 'tools registered', ok: tools.size() > 0, detail: `${tools.size()} tools` });
      checks.push({ name: 'channels', ok: gateway.channels.size > 0, detail: `${gateway.channels.size} channels` });
      checks.push({
        name: 'brain provider',
        ok: config.brain.provider === 'deterministic'
          || (!!config.brain.apiKey && !!config.brain.apiBase && !!config.brain.model),
        detail: config.brain.provider
      });
      checks.push({ name: 'rate limiting', ok: !!config.rateLimit.enabled });
      checks.push({ name: 'auth token', ok: !!config.authToken, detail: config.authToken ? 'set' : 'open access' });
      checks.push({ name: 'webhook signing', ok: !!config.webhook.signingSecret });
      checks.push({ name: 'pairing enabled', ok: !!config.pairing.enabled });
      checks.push({ name: 'scheduler enabled', ok: !!config.scheduler.enabled });
      checks.push({ name: 'cache enabled', ok: !!config.cache.enabled });
      checks.push({ name: 'metrics enabled', ok: !!config.metrics.enabled });
      checks.push({ name: 'dashboard enabled', ok: !!config.dashboard.enabled });
      checks.push({ name: 'websocket enabled', ok: !!config.websocket.enabled });
      checks.push({ name: 'conversation history', ok: config.conversation.maxTurns > 0, detail: `max=${config.conversation.maxTurns}` });
      checks.push({ name: 'memory dedup', ok: config.memory.dedupThreshold > 0, detail: `threshold=${config.memory.dedupThreshold}` });
      checks.push({
        name: 'config issues',
        ok: validateConfig(config).length === 0,
        detail: `${validateConfig(config).length} issues`
      });
      let allOk = true;
      for (const c of checks) {
        if (!c.ok) allOk = false;
        process.stdout.write(`[${c.ok ? 'OK' : 'WARN'}] ${c.name}${c.detail ? ` :: ${c.detail}` : ''}\n`);
      }
      process.stdout.write(allOk ? '\nall checks passed.\n' : '\nsome warnings detected.\n');
      break;
    }

    case 'trust': {
      const channel = args.flags.channel;
      const userId = args.flags.user;
      const level = args.flags.level as TrustLevel | undefined;
      if (!channel || !userId || !level) {
        process.stderr.write('trust requires --channel, --user, --level\n');
        process.exit(2);
      }
      const session = gateway.sessions.setTrust(channel, userId, level);
      if (!session) { process.stderr.write('no matching session\n'); process.exit(3); }
      process.stdout.write(`trust set: ${session.channel}/${session.userId} = ${session.trustLevel}\n`);
      break;
    }

    case 'pair': {
      if (args.sub === 'issue') {
        const channel = args.flags.channel;
        const userId = args.flags.user;
        const level = args.flags.level as TrustLevel | undefined;
        if (!channel || !userId || !level) {
          process.stderr.write('pair issue requires --channel, --user, --level\n');
          process.exit(2);
        }
        const result = gateway.issuePairing(channel, userId, level);
        if (!result) { process.stderr.write('pairing disabled\n'); process.exit(3); }
        process.stdout.write(`code=${result.code} expiresAt=${new Date(result.expiresAt).toISOString()}\n`);
      } else if (args.sub === 'redeem') {
        const code = args.flags.code;
        if (!code) { process.stderr.write('pair redeem requires --code\n'); process.exit(2); }
        const result = gateway.redeemPairing(code);
        if (!result.ok) { process.stderr.write('invalid or expired code\n'); process.exit(3); }
        process.stdout.write(`redeemed: ${result.channel}/${result.userId} -> ${result.trustLevel}\n`);
      } else if (args.sub === 'revoke') {
        const channel = args.flags.channel;
        const userId = args.flags.user;
        if (!channel || !userId) {
          process.stderr.write('pair revoke requires --channel, --user\n');
          process.exit(2);
        }
        const removed = gateway.revokePairing(channel, userId);
        process.stdout.write(`revoked ${removed} code(s)\n`);
      } else {
        process.stderr.write('pair requires sub-command: issue | redeem | revoke\n');
        process.exit(2);
      }
      break;
    }

    case 'snapshot': {
      if (!store) { process.stderr.write('persistence is disabled\n'); process.exit(3); }
      const name = args.flags.name ?? `snap-${Date.now()}`;
      const gzip = args.flags.gzip === 'true';
      const file = await store.writeSnapshot(name, {
        sessions: gateway.sessions.list(),
        memories: gateway.memories.list(),
        conversations: conversation
          ? gateway.sessions.list().flatMap((s) => conversation.list(s.id))
          : []
      }, { gzip });
      process.stdout.write(`snapshot written: ${file}\n`);
      break;
    }

    case 'restore': {
      if (!store) { process.stderr.write('persistence is disabled\n'); process.exit(3); }
      const name = args.flags.name;
      if (!name) { process.stderr.write('restore requires --name\n'); process.exit(2); }
      try {
        const snap = await store.readSnapshot(name);
        gateway.sessions.hydrate(snap.sessions);
        gateway.memories.hydrate(snap.memories);
        if (conversation) conversation.hydrate(snap.conversations);
        await gateway.persist();
        process.stdout.write(
          `restored: ${snap.sessions.length} sessions, ${snap.memories.length} memories, ${snap.conversations.length} turns\n`
        );
      } catch (error) {
        process.stderr.write(`restore failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(3);
      }
      break;
    }

    case 'export': {
      const target = args.flags.out ?? path.join(config.storage.workspaceDir, 'export.json');
      const payload = {
        exportedAt: new Date().toISOString(),
        sessions: gateway.sessions.list(),
        memories: gateway.memories.list(),
        conversations: conversation
          ? gateway.sessions.list().flatMap((s) => conversation.list(s.id))
          : []
      };
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
      process.stdout.write(`exported -> ${target}\n`);
      break;
    }

    case 'import': {
      const source = args.flags.in;
      if (!source) { process.stderr.write('import requires --in\n'); process.exit(2); }
      try {
        const raw = await fs.readFile(source, 'utf8');
        const parsed = JSON.parse(raw) as { memories?: unknown[] };
        const inserted = gateway.memories.importMemories(parsed.memories ?? []);
        process.stdout.write(`imported memories: ${inserted}\n`);
      } catch (error) {
        process.stderr.write(`import failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(3);
      }
      break;
    }

    default:
      process.stderr.write(`unknown command: ${args.command}\n${HELP}`);
      process.exit(2);
  }

  await gateway.shutdown('cli-done');
}

main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
