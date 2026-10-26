# Chowdeck MCP

An unofficial, MIT-licensed MCP server for discovering food, preparing orders and tracking deliveries on Chowdeck. This fork extends [thathman/chowdeck-mcp](https://github.com/thathman/chowdeck-mcp); original author and copyright notices are preserved. It is not affiliated with Chowdeck or Paystack.

## Features

**68 tools and four prompts**, including:

- Gift-recipient metadata, saved recipient profiles and defaults, rider notes and favourite recipes.
- `reorder_gift`: prepare a repeat gift with original options/packs, recipient, address, wallet preference, spending cap and current-price comparison. Returns a preview, never a purchase.
- `prepare_checkout`: parallel cart/account/vendor checks, live delivery/service/bag fees, discount quote, wallet shortfall and vendor/stock/minimum/budget checks. Incomplete fee data blocks a complete quote.
- `place_order`: required stable idempotency key, persistent attempt reservation before charging, cached successful results, ten-minute duplicate detection and explicit unknown outcomes. Supply `expected_total_naira` and `max_total_naira` to enforce the approved live quote and budget.
- Wallet payment and splitting, saved cards, native repeat orders, preserved packs, pickup and vendor preorder windows.
- `session_status`: saved-login validation and automatic renewal when Chowdeck permits, with no automatic OTP. A revoked login can still require a fresh sign-in.
- Exact nested item/option candidates, nearby vendor alternatives, timing logs and one-time cancellation/refund evidence. A wallet increase alone is not proof of a refund.
- `get_food_images`: actual menu photos as native MCP image content plus labelled source links. Public CDN allowlist, HTTPS, response-size/type limits, safe redirects and no account authorization headers.
- `get_api_map`: **94 observed storefront operations**, request fields and explicit gaps. [API map](API-MAP.md) · [Source evidence](STOREFRONT-EVIDENCE.md).

Some auxiliary flows are mapped without dedicated tools or complete captured schemas. This is a development release; synthetic tests and successful public config/photo reads do not establish real wallet charges, gift delivery, refund completion or an ordering-speed guarantee.

## Run locally

Requires Node.js 20 or later.

```sh
git clone https://github.com/atomicman57/chowdeck-mcp.git
cd chowdeck-mcp/mcp
npm ci --ignore-scripts
npm run build
node dist/index.js
```

For Claude Code, from your checkout:

```sh
claude mcp add chowdeck -- node /absolute/path/to/chowdeck-mcp/mcp/dist/index.js
```

For Codex, Claude Desktop, Cursor and other stdio hosts, use the equivalent MCP configuration:

```json
{
  "mcpServers": {
    "chowdeck": {
      "command": "node",
      "args": ["/absolute/path/to/chowdeck-mcp/mcp/dist/index.js"]
    }
  }
}
```

The Node runtime defaults to a session file under `~/.chowdeck-mcp/session.json` with restrictive filesystem permissions. This file contains account credentials and is **not encrypted**. For temporary sessions set `CHOWDECK_SESSION_PERSISTENCE=memory`. For encrypted storage, configure your own `CHOWDECK_CREDENTIAL_HELPER` executable and optional `CHOWDECK_CREDENTIAL_SESSION` name: the helper must support `get-session NAME` (JSON on stdout) and `put-session NAME` (JSON on stdin). A missing record should report `is missing from the central store` on stderr; other failures stop operation without writing a plaintext fallback. The helper itself is supplied by the operator.

Call `get_setup_status` before ordering. OTP sending requires explicit approval. Confirm the delivery address, recipient, vendor, items, payment method and live total before placement. Credentials are never included in tool responses.

## Host for trusted agents

The Cloudflare Worker is **single-account**: every authorized client shares one Chowdeck account. Deploy a separate Worker for each owner. Do not treat this as multi-tenant hosting.

```sh
cd mcp
npm ci --ignore-scripts
npm test
npx wrangler deploy
npx wrangler secret put OWNER_ACCESS_KEY
npx wrangler secret put SESSION_ENCRYPTION_KEY
```

Choose your own Worker name in `mcp/wrangler.jsonc`. Generate a random owner key of at least 32 characters and a separate 32-byte AES key encoded as exactly 64 hexadecimal characters; save both in your password manager and enter them into the secret prompts. Losing or changing the encryption key makes existing encrypted account state unreadable. No account IDs, deployed endpoint or secret values are bundled.

The Worker exposes:

- `/mcp`: authenticated Streamable HTTP MCP.
- `/setup`: owner-protected phone/OTP sign-in form; enter codes directly here rather than in chat.
- OAuth discovery, dynamic registration, PKCE S256 and explicit owner consent with `chowdeck.read` / `chowdeck.write` scopes. One-hour access tokens and rotating refresh tokens valid until revoked.
- `/health`: public, credential-free service status.
- `/oauth-status`: owner-key-protected, sanitized last OAuth event, with no codes or tokens.

The account session and application state use AES-GCM encrypted Durable Object storage. HTTP requests are serialized for this shared account; deployments preserve its data. OAuth authorization connects an agent to the MCP; the separate Chowdeck phone/OTP sign-in connects the account.

For a stdio-only client connecting to **your own** deployment, run `node hosting/bridge.mjs` with `CHOWDECK_MCP_URL` and `CHOWDECK_MCP_TOKEN` injected by a secret-manager launcher. Do not commit tokens in client configuration. The bridge never automatically retries a failed purchase request.

For loopback HTTP instead, set a random `CHOWDECK_HTTP_TOKEN` of at least 32 characters and run `node dist/index.js --http`; it binds to `127.0.0.1:8147`.

## Verification and contribution

```sh
cd mcp
npm ci --ignore-scripts
npm test
npm audit
```

The 27 tests build both runtimes and cover synthetic gift/wallet checkout, exact fees and shortfalls, price/vendor blocking, durable duplicate protection, login renewal, OAuth/PKCE, encrypted state restoration, owner/CSRF protection and image handling. They do not make paid orders. Existing account login, live charges, gifts and deliveries require separate authorized verification.

See [SECURITY.md](SECURITY.md) for deployment boundaries. The npm package is marked private in this fork to avoid accidentally publishing under the original author's package name; build from source or deploy your own Worker.
