# Amazon Browser MCP

A private, read-only remote MCP server for Amazon order history. Cloudflare
Workers hosts the MCP and GitHub OAuth layers. The default browser backend is a
localhost-only Playwright agent reached through an outbound Cloudflare Tunnel
and Workers VPC; Browserbase remains an explicit hosted fallback.

The first release exposes exactly four tools:

- `amazon_session_status`
- `amazon_list_orders`
- `amazon_get_order`
- `amazon_find_orders`

There are no generic URL, click, type, form, JavaScript, screenshot, download, purchase, cancellation, return, or account-setting tools.

## Architecture

```text
ChatGPT or Claude
        |
        | MCP over HTTPS + OAuth
        v
Cloudflare Worker
  - GitHub identity + connector-origin allowlists
  - explicit read-only consent
  - strict MCP schemas
        |
        v
single named Durable Object
  - serializes every Amazon read
  - bounded queue
        |
        v
HMAC-signed Workers VPC request
  - one fixed private service
  - outbound-only Cloudflare Tunnel
        |
        v
localhost-only Bun service
  - four typed operations
  - Playwright + dedicated Chromium profile
  - cookies stay on the Mac
        |
        v
deterministic allowlisted extraction -> structured JSON only
```

TypeScript is used throughout. Bun installs dependencies, runs checks, and hosts
the small local service; Cloudflare `workerd` runs the Worker. See
[Local Amazon browser agent](docs/local-browser-agent.md) for the primary
zero-browser-minute runtime. Setting `AMAZON_BROWSER_BACKEND` to `browserbase`
selects the hosted Cloudflare-Puppeteer/Browserbase fallback.

## Trust and privacy

- The GitHub OAuth secret and local-agent HMAC secret are encrypted Cloudflare
  Worker secrets. The same HMAC secret and tunnel token live in macOS Keychain,
  never in source.
- OAuth authorization accepts only official ChatGPT and Claude callback origins plus the exact native Codex loopback callback. After GitHub login, the Worker shows the connector name, callback origin, and `amazon.read` scope and requires one explicit approval click. The approval POST ends on a same-origin handoff page before continuing to the connector, avoiding embedded Chromium's cross-origin form-redirect restriction.
- Amazon credentials are entered manually into a dedicated local Chrome
  profile. The code never receives them, and `Login Data*` is purged after
  login and before every production start. Amazon cookies remain on the Mac.
- The private tunnel has no public hostname or inbound firewall rule. Workers
  VPC pins requests to one tunnel and `127.0.0.1:43218`; the local server also
  requires an HMAC timestamp and one-time nonce.
- Browserbase fallback secrets and Context state remain a separate,
  deliberately selected third-party trust boundary. Recording, logging,
  automated CAPTCHA solving, and keep-alive are disabled there.
- During automated reads, the browser guard allows only read HTTP methods and reviewed Amazon order/sign-in/challenge paths. Site JavaScript is disabled, and browser downloads are denied. Together with request interception, this blocks form submission, background writes, cart, checkout, buying, cancellation, returns, reviews, wishlists, settings, popups, downloads, and unapproved hosts. The separate one-time, human-controlled login window does not intercept Amazon authentication traffic and is never exposed as an MCP browser tool.
- Returned fields are limited to order IDs, dates, totals, statuses, item titles, ASINs, quantities, shipments, and price breakdowns.
- Delivery addresses, recipient names, payment instruments, email, phone, tracking numbers, messages, URLs, raw HTML, screenshots, and cookies are excluded.
- Site strings are normalized, length-limited, marked as untrusted web data, and never interpreted by an inner LLM.

Tool annotations describe all four tools as read-only, but enforcement is also implemented in exact request and response schemas, fixed URL construction, request interception, disabled site JavaScript, deterministic parsing, and the absence of browser primitives.

## Prerequisites

- Bun 1.3+
- Node.js 22+ for Wrangler
- A Cloudflare account
- A GitHub OAuth app
- Playwright Chromium (`bun run local-agent:install-browser`)
- `cloudflared` 2025.7.0 or newer
- A dedicated local Chromium profile containing a manually authenticated Amazon
  session

Browserbase is optional and requires its own account, API key, and authenticated
Context only when the hosted fallback is selected.

Amazon is bot-protected. A free Browserbase plan may present a challenge or block login because proxies, Verified sessions, and automated CAPTCHA solving are paid features. It also has a browser-minute allowance; live MCP reads stop when that allowance is exhausted and return `BROWSER_QUOTA_EXHAUSTED`. This connector intentionally does not bypass challenges; it returns `CHALLENGE_REQUIRED` so the user can resolve access manually or change the Browserbase plan.

## Browser runtime setup

Install dependencies:

```bash
bun install
bun run local-agent:install-browser
```

Follow [the local-agent setup](docs/local-browser-agent.md) to create the
outbound-only tunnel and VPC service, store generated secrets in Worker Secrets
and macOS Keychain, perform the one-time Amazon login, and install the two
LaunchAgents.

### Browserbase fallback

To use the hosted fallback instead, create a dedicated Browserbase Context,
complete Amazon sign-in in a non-recorded interactive session, and release that
session so Browserbase persists the Context. Store `BROWSERBASE_API_KEY` and
`AMAZON_CONTEXT_ID` as Worker secrets, then set
`AMAZON_BROWSER_BACKEND` to `browserbase` in the ignored `wrangler.jsonc`.
Production fallback reads create non-persistent, non-recorded sessions from
that Context; they never expose a generic browser tool or Live View URL.

## Cloudflare setup

Create your local deployment config. It is intentionally ignored because it
contains account-specific Cloudflare and GitHub identifiers:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Create a dedicated KV namespace for this Worker. Do not reuse another MCP server's OAuth namespace because client, grant, token, and state keys are not namespaced per Worker:

```bash
bunx wrangler kv namespace create AMAZON_BROWSER_MCP_OAUTH_KV
```

Keep the Worker binding name as `OAUTH_KV`, but set its `id` in `wrangler.jsonc` to the new namespace ID.

Create a separate GitHub OAuth app for this Worker. After the first deploy gives you the Worker hostname, configure:

- Homepage: `https://amazon-browser-mcp.YOUR_SUBDOMAIN.workers.dev`
- Callback: `https://amazon-browser-mcp.YOUR_SUBDOMAIN.workers.dev/callback`

Store secrets interactively:

```bash
bunx wrangler secret put LOCAL_BROWSER_AGENT_SECRET
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
```

For Browserbase fallback, also set `BROWSERBASE_API_KEY` and
`AMAZON_CONTEXT_ID`, then change `AMAZON_BROWSER_BACKEND` in the ignored
deployment config to `browserbase`.

The deployment is single-user. `ALLOWED_GITHUB_USER_ID` in `wrangler.jsonc` must be the stable numeric GitHub ID of the allowed account.

Deploy:

```bash
bun run check
bun run deploy
```

Add `https://amazon-browser-mcp.YOUR_SUBDOMAIN.workers.dev/mcp` as a custom connector in ChatGPT or Claude. The connector opens GitHub and then shows one read-only approval page; no custom access code is required.

## Verification

```bash
bun run typecheck
bun run test
bunx wrangler deploy --dry-run --config wrangler.example.jsonc
```

Tests use fictional handcrafted Amazon-like HTML only. Authenticated Amazon pages, cookies, Context data, and real order history must never be committed or used in CI fixtures.

Live QA is intentionally manual and limited. For the local backend:

1. Check `amazon_session_status`.
2. Read one order-history page with a small limit.
3. Compare order IDs, dates, totals, and item titles against the local dedicated
   Chromium profile.
4. Confirm the localhost service and tunnel are healthy.
5. Confirm address, payment, tracking, and raw-page fields never appear in MCP output.

For the Browserbase fallback, perform the same two MCP reads, confirm no
persistent Context session is running during production QA, and verify that the
ephemeral session is released afterward.

## License

MIT
