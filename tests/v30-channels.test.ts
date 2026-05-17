import { describe, it, expect } from 'vitest';
import { parseWhatsApp } from '../src/channels/adapters/whatsapp-adapter.js';
import { parseTelegram } from '../src/channels/adapters/telegram-adapter.js';
import { parseDiscord } from '../src/channels/adapters/discord-adapter.js';

describe('v3.0 channel adapters', () => {
  describe('WhatsApp Cloud API adapter', () => {
    it('parses a text message into IncomingMessage', () => {
      const envelope = {
        entry: [{
          changes: [{
            value: {
              messages: [{
                from: '15551234567',
                id: 'wamid.abc',
                type: 'text',
                text: { body: 'hello from whatsapp' }
              }]
            }
          }]
        }]
      };
      const msgs = parseWhatsApp(envelope);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        channel: 'whatsapp',
        userId: '15551234567',
        text: 'hello from whatsapp',
        clientId: 'wamid.abc'
      });
    });

    it('ignores non-text message types', () => {
      const envelope = {
        entry: [{ changes: [{ value: { messages: [{ from: 'x', type: 'image' }] } }] }]
      };
      expect(parseWhatsApp(envelope)).toEqual([]);
    });

    it('returns empty for malformed envelopes', () => {
      expect(parseWhatsApp(null)).toEqual([]);
      expect(parseWhatsApp({})).toEqual([]);
      expect(parseWhatsApp({ entry: [] })).toEqual([]);
    });

    it('honours custom channel name', () => {
      const env = {
        entry: [{ changes: [{ value: { messages: [{ from: '1', type: 'text', text: { body: 'x' } }] } }] }]
      };
      expect(parseWhatsApp(env, { channel: 'wa-prod' })[0]?.channel).toBe('wa-prod');
    });
  });

  describe('Telegram Bot API adapter', () => {
    it('parses a regular text message', () => {
      const update = {
        update_id: 1,
        message: {
          message_id: 42,
          from: { id: 999, username: 'tester' },
          chat: { id: -100, type: 'private' },
          text: 'hi from telegram'
        }
      };
      const msgs = parseTelegram(update);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        channel: 'telegram',
        userId: '999',
        text: 'hi from telegram',
        clientId: 'tg-42'
      });
    });

    it('parses callback queries', () => {
      const update = {
        callback_query: {
          id: 'cb-1',
          from: { id: 7, username: 'bob' },
          data: 'menu:settings'
        }
      };
      const msgs = parseTelegram(update);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.text).toBe('menu:settings');
    });

    it('ignores empty text', () => {
      expect(parseTelegram({ message: { from: { id: 1 }, text: '' } })).toEqual([]);
    });
  });

  describe('Discord adapter', () => {
    it('parses slash command interactions', () => {
      const interaction = {
        type: 2,
        id: 'int-1',
        member: { user: { id: '111', username: 'discord-user' } },
        data: { name: 'ask', options: [{ name: 'q', value: 'what is the time?' }] }
      };
      const msgs = parseDiscord(interaction);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.text).toBe('/ask what is the time?');
      expect(msgs[0]?.userId).toBe('111');
    });

    it('parses webhook messages', () => {
      const webhook = {
        id: 'msg-1',
        author: { id: '222', username: 'channeluser' },
        content: 'plain webhook text',
        channel_id: 'chan-x'
      };
      const msgs = parseDiscord(webhook);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.text).toBe('plain webhook text');
    });

    it('returns empty for unknown payload shape', () => {
      expect(parseDiscord({ type: 99 })).toEqual([]);
      expect(parseDiscord(null)).toEqual([]);
    });
  });
});
