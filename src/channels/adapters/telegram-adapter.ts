import type { IncomingMessage } from '../../types.js';

/**
 * Telegram Bot API webhook payload adapter.
 *
 * Telegram posts updates to a webhook URL configured via setWebhook.
 * Each update has either a `message`, `edited_message`, or callback. We
 * handle text messages and inline button callbacks.
 *
 * Reference shape:
 *   { update_id, message: { message_id, from:{id,username}, chat:{id}, text } }
 */
export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    from?: { id?: number; username?: string; first_name?: string };
    chat?: { id?: number; type?: string };
    text?: string;
    caption?: string;
    photo?: Array<{ file_id?: string }>;
    voice?: { file_id?: string };
    document?: { file_id?: string; file_name?: string };
  };
  edited_message?: TelegramUpdate['message'];
  callback_query?: {
    id?: string;
    from?: { id?: number; username?: string };
    data?: string;
  };
}

export function parseTelegram(envelope: unknown, defaults: { channel?: string } = {}): IncomingMessage[] {
  if (!envelope || typeof envelope !== 'object') return [];
  const env = envelope as TelegramUpdate;
  const channel = defaults.channel ?? 'telegram';

  const msg = env.message ?? env.edited_message;
  if (msg && msg.from?.id !== undefined) {
    const text = msg.text ?? msg.caption;
    // Surface non-text media as descriptive placeholders so downstream
    // tooling at least sees them; lets the agent acknowledge.
    let inferred = text;
    let mediaType: string | undefined;
    if (!inferred) {
      if (msg.photo && msg.photo.length > 0) { inferred = '[photo]'; mediaType = 'photo'; }
      else if (msg.voice?.file_id) { inferred = '[voice]'; mediaType = 'voice'; }
      else if (msg.document?.file_id) { inferred = `[document: ${msg.document.file_name ?? 'unnamed'}]`; mediaType = 'document'; }
    }
    if (inferred && inferred.length > 0) {
      return [{
        channel,
        userId: String(msg.from.id),
        text: inferred,
        clientId: msg.message_id !== undefined ? `tg-${msg.message_id}` : undefined,
        metadata: {
          source: 'telegram',
          username: msg.from.username,
          chatId: msg.chat?.id,
          ...(mediaType ? { mediaType } : {})
        }
      }];
    }
  }

  if (env.callback_query?.from?.id !== undefined && typeof env.callback_query.data === 'string') {
    return [{
      channel,
      userId: String(env.callback_query.from.id),
      text: env.callback_query.data,
      clientId: env.callback_query.id,
      metadata: { source: 'telegram-callback' }
    }];
  }

  return [];
}
