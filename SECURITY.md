# Security Policy

## Supported Versions

We support the latest minor release and the previous one. Older releases receive critical security fixes only at maintainer discretion.

| Version | Supported          |
|---------|--------------------|
| 2.6.x   | :white_check_mark: |
| 2.5.x   | :white_check_mark: |
| < 2.5   | :x:                |

## Reporting a Vulnerability

If you believe you have found a security vulnerability in Garud Agent, please **do not** open a public GitHub issue. Instead:

1. Open a private security advisory at https://github.com/gopendrasharma89-tech/garud-agent/security/advisories/new
2. Include reproduction steps, affected versions, and any proof-of-concept code
3. We aim to acknowledge within 48 hours and provide a fix or mitigation plan within 7 days

## Hardening Guidance

Garud Agent ships with safe defaults but several knobs deserve attention in production deployments:

- **`authToken`** — set a strong `authToken` in config; without it, mutating endpoints accept anonymous requests
- **`readToken`** — separate token grants read-only access (useful for dashboards / monitoring)
- **`webhook.signingSecret`** — always set for inbound webhooks; HMAC-SHA256 with constant-time comparison
- **`rateLimit.enabled`** — keep enabled in production; tune `maxRequests` and `windowMs` to your traffic
- **`quotas.defaultDailyLimit`** — bounds per-trust-level tool consumption
- **Tool surface** — review `tools.list()` and restrict via `policy.rules` based on trust level
- **`crypto.*` tools** — derive keys via `scrypt`, use AES-256-GCM; rotate `<key>` secrets regularly
- **Plugin loader** — only load trusted plugins; v2.6 has no sandbox (planned in v2.7+)
- **Sub-agents** — capped at 4 concurrent and cannot nest; consider lowering for resource-constrained hosts

## Disclosure Timeline

We follow coordinated disclosure: once a fix is released, the advisory is published with a CVE if applicable.
