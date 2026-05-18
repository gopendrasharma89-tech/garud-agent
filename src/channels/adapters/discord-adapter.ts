import type { IncomingMessage } from '../../types.js';

/**
 * Discord interactions / message webhook payload adapter.
 *
 * Discord posts two kinds of payloads:
 *   1. Interactions (slash commands, buttons) — type 2 = APPLICATION_COMMAND
 *   2. Webhook messages from a configured webhook URL
 *
 * Reference shape (slash command):
 *   { type: 2, member: { user: { id, username } }, data: { name, options:[{value}] } }
 */
export interface DiscordInteraction {
  type?: number;
  id?: string;
  member?: { user?: { id?: string; username?: string } };
  user?: { id?: string; username?: string };
  data?: {
    name?: string;
    options?: Array<{ name?: string; value?: unknown }>;
  };
}

export interface DiscordMessageWebhook {
  id?: string;
  author?: { id?: string; username?: string };
  content?: string;
  channel_id?: string;
}

export function parseDiscord(envelope: unknown, defaults: { channel?: string } = {}): IncomingMessage[] {
  if (!envelope || typeof envelope !== 'object') return [];
  const channel = defaults.channel ?? 'discord';

  // Interactions: type 2 = APPLICATION_COMMAND.
  const interaction = envelope as DiscordInteraction;
  if (interaction.type === 2 && interaction.data?.name) {
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!userId) return [];
    // Preserve option names so the agent sees both name and value.
    const optionsText = (interaction.data.options ?? [])
      .map((o) => `${o.name ?? '_'}=${typeof o.value === 'string' ? o.value : JSON.stringify(o.value)}`)
      .join(' ');
    const text = optionsText
      ? `/${interaction.data.name} ${optionsText}`
      : `/${interaction.data.name}`;
    return [{
      channel,
      userId,
      text,
      clientId: interaction.id,
      metadata: {
        source: 'discord-interaction',
        username: interaction.member?.user?.username ?? interaction.user?.username,
        commandName: interaction.data.name
      }
    }];
  }

  // Discord webhook message.
  const message = envelope as DiscordMessageWebhook;
  if (message.author?.id && typeof message.content === 'string' && message.content.length > 0) {
    return [{
      channel,
      userId: message.author.id,
      text: message.content,
      clientId: message.id,
      metadata: { source: 'discord-message', username: message.author.username, channelId: message.channel_id }
    }];
  }

  return [];
}
