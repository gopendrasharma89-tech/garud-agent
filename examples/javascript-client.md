# JavaScript / TypeScript Client Examples

## Minimal HTTP client

```ts
const BASE = 'http://127.0.0.1:3010';

async function send(text: string) {
  const res = await fetch(`${BASE}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'http', userId: 'alice', text })
  });
  return res.json();
}

console.log(await send('remember demo day is friday'));
console.log(await send('what do you know?'));
```

## SSE streaming reply

```ts
async function stream(text: string) {
  const res = await fetch(`${BASE}/message/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'http', userId: 'alice', text })
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(decoder.decode(value));
  }
}

await stream('hello');
```

## WebSocket client

```ts
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3010/ws');
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'message',
    payload: { channel: 'http', userId: 'alice', text: 'hi via ws' }
  }));
});
ws.on('message', (data) => console.log(data.toString()));
```

## Long-term memory

```ts
// Append a fact
await fetch(`${BASE}/longterm/append`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ section: 'preferences', fact: 'user prefers dark mode' })
});

// Read facts by date
const today = new Date().toISOString().slice(0, 10);
const facts = await (await fetch(`${BASE}/longterm/by-date/${today}`)).json();
console.log(facts);
```

## Audit replay

```ts
const reply = await fetch(`${BASE}/audit/replay`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ requestId: '<original-request-id>' })
}).then((r) => r.json());
console.log(reply);
```

## Signed webhook

```ts
import crypto from 'node:crypto';

const secret = 'shared-secret';
const payload = JSON.stringify({ userId: 'alice', text: 'hello via webhook' });
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

await fetch(`${BASE}/webhook/console`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-garud-signature': sig },
  body: payload
});
```
