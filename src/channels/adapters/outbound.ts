/**
 * Outbound channel senders. These post reply text back to the platform's API
 * after Garud's runtime produces a response. All use Node's built-in
 * `fetch` — no SDK or external dependency.
 *
 * Each sender is intentionally a thin function so it can be swapped or
 * stubbed in tests without taking on platform SDKs.
 */

export interface OutboundResult {
  ok: boolean;
  status?: number;
  error?: string;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<OutboundResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Send a WhatsApp text reply via Meta's Cloud API. */
export async function sendWhatsApp(opts: {
  accessToken: string;
  phoneNumberId: string;
  to: string;
  text: string;
}): Promise<OutboundResult> {
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(opts.phoneNumberId)}/messages`;
  return postJson(url,
    { messaging_product: 'whatsapp', to: opts.to, type: 'text', text: { body: opts.text } },
    { authorization: `Bearer ${opts.accessToken}` }
  );
}

/** Send a Telegram text reply via the Bot API. */
export async function sendTelegram(opts: {
  botToken: string;
  chatId: number | string;
  text: string;
}): Promise<OutboundResult> {
  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;
  return postJson(url, { chat_id: opts.chatId, text: opts.text });
}

/** Send a Discord webhook message. */
export async function sendDiscord(opts: {
  webhookUrl: string;
  content: string;
  username?: string;
}): Promise<OutboundResult> {
  return postJson(opts.webhookUrl, { content: opts.content, username: opts.username });
}

/** Send a Slack chat message via webhook URL. */
export async function sendSlack(opts: {
  webhookUrl: string;
  text: string;
}): Promise<OutboundResult> {
  return postJson(opts.webhookUrl, { text: opts.text });
}
