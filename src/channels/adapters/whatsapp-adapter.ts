import type { IncomingMessage } from '../../types.js';

/**
 * WhatsApp Cloud API webhook payload adapter.
 *
 * Translates Meta's WhatsApp Cloud API messaging webhooks into Garud's
 * normalized IncomingMessage shape. No SDK required — we parse the raw
 * JSON body Meta posts to `/channel/whatsapp`.
 *
 * Reference shape:
 *   { entry: [{ changes: [{ value: { messages: [{ from, text:{body}, type }] }}] }] }
 */
export interface WhatsAppEnvelope {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

export function parseWhatsApp(envelope: unknown, defaults: { channel?: string } = {}): IncomingMessage[] {
  if (!envelope || typeof envelope !== 'object') return [];
  const env = envelope as WhatsAppEnvelope;
  const out: IncomingMessage[] = [];
  for (const entry of env.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        if (msg.type !== 'text' || !msg.from || !msg.text?.body) continue;
        out.push({
          channel: defaults.channel ?? 'whatsapp',
          userId: msg.from,
          text: msg.text.body,
          clientId: msg.id,
          metadata: { source: 'whatsapp' }
        });
      }
    }
  }
  return out;
}
