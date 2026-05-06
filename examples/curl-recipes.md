# Curl Recipes

Default base URL: `http://127.0.0.1:3010`.

## Health & introspection
```bash
curl localhost:3010/health
curl localhost:3010/live
curl localhost:3010/ready
curl localhost:3010/slo
curl localhost:3010/api/version
curl localhost:3010/metrics            # Prometheus
curl localhost:3010/                   # HTML dashboard
```

## Send a message
```bash
curl -X POST localhost:3010/message \
     -H "content-type: application/json" \
     -d '{"channel":"http","userId":"alice","text":"remember demo day is friday"}'
```

## Streaming reply (SSE)
```bash
curl -N -X POST localhost:3010/message/stream \
     -H "content-type: application/json" \
     -d '{"channel":"http","userId":"alice","text":"hello"}'
```

## Memories
```bash
curl 'localhost:3010/memories?q=demo&limit=5'
curl 'localhost:3010/memories?sessionId=<id>'
curl -X POST localhost:3010/memories/import \
     -H "content-type: application/json" \
     -d '{"memories":[{"text":"hi","tags":["seed"]}]}'
```

## Audit
```bash
curl 'localhost:3010/audit?limit=20'
curl 'localhost:3010/audit?kind=tool'
curl 'localhost:3010/audit/export' -o audit.ndjson
curl -X POST localhost:3010/audit/replay \
     -H "content-type: application/json" \
     -d '{"requestId":"<request-id>"}'
```

## Pairing
```bash
curl -X POST localhost:3010/pairing/issue \
     -H "content-type: application/json" \
     -d '{"channel":"http","userId":"bob","trust":"trusted"}'
curl -X POST localhost:3010/pairing/redeem \
     -H "content-type: application/json" \
     -d '{"code":"<code>"}'
```

## Tools
```bash
curl localhost:3010/tools
curl localhost:3010/stats
```

## Signed webhook
```bash
PAYLOAD='{"userId":"alice","text":"hello via webhook"}'
SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "<secret>" -binary | xxd -p -c 256)
curl -X POST localhost:3010/webhook/console \
     -H "content-type: application/json" \
     -H "x-garud-signature: sha256=$SIG" \
     -d "$PAYLOAD"
```
