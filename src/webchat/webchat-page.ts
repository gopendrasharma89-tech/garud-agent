export interface WebChatOptions {
  agent: string;
  version: string;
  webhookPrefix: string;
}

/**
 * Single-file WebChat UI (OpenClaw-style built-in channel). Served at
 * GET /webchat; posts messages to the webhook channel endpoint and renders
 * replies. Auth token (if the gateway requires one) is kept in localStorage.
 */
export function renderWebChat(options: WebChatOptions): string {
  const { agent, version, webhookPrefix } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${agent} WebChat</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b1020; color: #e6e9f2; display: flex; flex-direction: column; height: 100vh; }
  header { padding: 12px 16px; background: #11182f; border-bottom: 1px solid #223; display: flex; gap: 10px; align-items: center; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .v { color: #7f8ab3; font-size: 12px; }
  header input { margin-left: auto; background: #0b1020; color: #e6e9f2; border: 1px solid #334; border-radius: 6px; padding: 4px 8px; font-size: 12px; width: 160px; }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 78%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.45; }
  .me { align-self: flex-end; background: #2b4bcf; }
  .bot { align-self: flex-start; background: #1a2340; }
  .sys { align-self: center; color: #7f8ab3; font-size: 12px; }
  form { display: flex; gap: 8px; padding: 12px 16px; background: #11182f; border-top: 1px solid #223; }
  form input { flex: 1; background: #0b1020; color: #e6e9f2; border: 1px solid #334; border-radius: 8px; padding: 10px 12px; font-size: 14px; }
  form button { background: #2b4bcf; color: white; border: 0; border-radius: 8px; padding: 10px 16px; font-size: 14px; cursor: pointer; }
  form button.alt { background: #1a2340; }
</style>
</head>
<body data-testid="garud-webchat">
<header>
  <h1>🦅 ${agent} WebChat</h1>
  <span class="v">v${version}</span>
  <input id="token" type="password" placeholder="auth token (optional)">
</header>
<div id="log"><div class="sys">connected to ${agent} — try /help</div></div>
<form id="f">
  <input id="text" autocomplete="off" placeholder="message ${agent}…" autofocus>
  <button type="submit">send</button>
  <button type="button" class="alt" id="newbtn" title="clear conversation">/new</button>
</form>
<script>
  const log = document.getElementById('log');
  const tokenInput = document.getElementById('token');
  tokenInput.value = localStorage.getItem('garud-token') || '';
  tokenInput.addEventListener('change', () => localStorage.setItem('garud-token', tokenInput.value));
  let userId = localStorage.getItem('garud-webchat-user');
  if (!userId) {
    userId = 'webchat-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('garud-webchat-user', userId);
  }
  function add(cls, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }
  async function send(text) {
    add('me', text);
    const headers = { 'content-type': 'application/json' };
    if (tokenInput.value) headers.authorization = 'Bearer ' + tokenInput.value;
    try {
      const res = await fetch('${webhookPrefix}/http', {
        method: 'POST', headers,
        body: JSON.stringify({ userId, text })
      });
      const body = await res.json();
      if (body && body.reply && typeof body.reply.text === 'string') add('bot', body.reply.text);
      else add('sys', 'error: ' + (body && body.error ? body.error : res.status));
    } catch (err) {
      add('sys', 'network error: ' + err);
    }
  }
  document.getElementById('f').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('text');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  });
  document.getElementById('newbtn').addEventListener('click', () => send('/new'));
</script>
</body>
</html>`;
}
