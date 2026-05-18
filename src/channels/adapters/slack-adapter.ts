import type { IncomingMessage } from '../../types.js';

/**
 * Slack Events API webhook payload adapter.
 *
 * Slack posts events as JSON with an outer envelope that includes an inner
 * `event` block. We handle:
 *   - `url_verification` challenge (caller should return `{challenge}` plain text)
 *   - `event_callback` with `message` events
 *
 * Reference shape:
 *   { type: 'event_callback', event: { type: 'message', user, text, channel, ts } }
 */
export interface SlackEvent {
  type?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  subtype?: string;
  bot_id?: string;
}

export interface SlackEnvelope {
  type?: 'url_verification' | 'event_callback' | string;
  challenge?: string;
  event?: SlackEvent;
  team_id?: string;
  event_id?: string;
}

export interface SlackParseResult {
  /** When defined, the caller should respond with this challenge string. */
  challenge?: string;
  messages: IncomingMessage[];
}

export function parseSlack(envelope: unknown, defaults: { channel?: string } = {}): SlackParseResult {
  if (!envelope || typeof envelope !== 'object') return { messages: [] };
  const env = envelope as SlackEnvelope;

  // URL verification handshake.
  if (env.type === 'url_verification' && typeof env.challenge === 'string') {
    return { challenge: env.challenge, messages: [] };
  }

  if (env.type !== 'event_callback' || !env.event) return { messages: [] };
  const event = env.event;
  // Skip bot messages and edits/joins to avoid loops.
  if (event.bot_id || event.subtype) return { messages: [] };
  if (event.type !== 'message' || !event.user || typeof event.text !== 'string' || event.text.length === 0) {
    return { messages: [] };
  }

  return {
    messages: [{
      channel: defaults.channel ?? 'slack',
      userId: event.user,
      text: event.text,
      clientId: env.event_id ?? event.ts,
      metadata: { source: 'slack', channelId: event.channel, teamId: env.team_id }
    }]
  };
}
