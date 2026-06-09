#!/usr/bin/env node
import { bootstrap } from './bootstrap.js';
import { defaultConfig, loadConfigFile, mergeConfig, validateConfig } from './config.js';
import { createServer } from './server.js';
import { WsServer } from './ws/ws-server.js';

async function main(): Promise<void> {
  const fileConfig = await loadConfigFile().catch(() => ({}));
  const config = mergeConfig(defaultConfig, fileConfig);
  const issues = validateConfig(config);
  if (issues.length) {
    process.stderr.write('config validation issues:\n');
    for (const issue of issues) {
      process.stderr.write(`  - ${issue.path}: ${issue.message}\n`);
    }
    process.exit(2);
  }

  const { gateway, scheduler, logger, tools, metrics, broadcastChannel, longterm, dailyLog, subagent, nodes, hooks, workspace, heartbeat, embeddings, costTracker, tracer, memoryIndex, skillLibrary, heartbeatScheduler, mcpClients, hybrid } = await bootstrap(config);
  heartbeat.start();

  if (process.argv.includes('--demo')) {
    const reply = await gateway.handle({
      channel: 'http',
      userId: 'owner',
      text: 'Remember that the launch checklist needs staging signoff',
      trustLevel: 'owner'
    });
    process.stdout.write(reply.text + '\n');
    await gateway.shutdown('demo-complete');
    return;
  }

  let wsServer: WsServer | undefined;
  if (config.websocket.enabled) {
    wsServer = new WsServer(gateway, {
      path: config.websocket.path,
      authToken: config.websocket.token ?? config.authToken,
      logger
    });
    broadcastChannel.subscribe((session, reply) => {
      wsServer?.broadcast({ type: 'broadcast', session, reply });
    });
  }

  const server = createServer({
    gateway, config, tools, metrics,
    logger: logger.child('http'),
    wsClientCount: () => wsServer?.size() ?? 0,
    longterm, dailyLog, subagent, nodes, hooks, workspace, heartbeat,
    embeddings, costTracker, tracer,
    memoryIndex, skills: skillLibrary, heartbeatScheduler, mcpClients, hybrid,
    ...(process.env.GARUD_WORKSPACE_SIGN_SECRET ? { workspaceSignSecret: process.env.GARUD_WORKSPACE_SIGN_SECRET } : {}),
    channelSecrets: {
      ...(process.env.GARUD_WHATSAPP_SECRET ? { whatsapp: process.env.GARUD_WHATSAPP_SECRET } : {}),
      ...(process.env.GARUD_TELEGRAM_SECRET ? { telegram: process.env.GARUD_TELEGRAM_SECRET } : {}),
      ...(process.env.GARUD_DISCORD_SECRET ? { discord: process.env.GARUD_DISCORD_SECRET } : {}),
      ...(process.env.GARUD_SLACK_SECRET ? { slack: process.env.GARUD_SLACK_SECRET } : {})
    }
  });
  if (wsServer) wsServer.attach(server);

  server.listen(config.port, config.host, () => {
    logger.info('garud-agent listening', {
      url: `http://${config.host}:${config.port}`,
      ws: config.websocket.enabled ? `ws://${config.host}:${config.port}${config.websocket.path}` : 'off',
      brain: gateway.getRuntime().getBrainName(),
      persistent: config.storage.persistent,
      tools: tools.size(),
      scheduler: scheduler ? scheduler.list().length : 0,
      metrics: !!metrics,
      dashboard: config.dashboard.enabled
    });
  });
  scheduler?.start();

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    scheduler?.stop();
    wsServer?.closeAll();
    server.close();
    await gateway.shutdown(signal);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
