# Amazon Browser MCP

A private, read-only remote MCP server for Amazon order history. It runs on Cloudflare Workers, uses a Browserbase-hosted Chromium session with a dedicated saved Amazon login, and protects the public MCP endpoint with GitHub OAuth.

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
Browserbase session API
  - dedicated Amazon Context
  - context persist=false for reads
  - recording/logging/CAPTCHA solving disabled
        |
        v
Cloudflare Puppeteer -> Browserbase Chromium -> amazon.com
        |
        v
deterministic allowlisted extraction -> structured JSON only
```

TypeScript is used throughout. Bun installs dependencies and runs local checks; Cloudflare `workerd` runs the Worker. Browserbase runs Chromium. Cloudflare's Worker-compatible Puppeteer build is the production browser driver, with a native Worker WebSocket transport for Browserbase CDP, so no additional server or Browserbase Function is required.

## Trust and privacy

- The Browserbase API key, Amazon Context ID, and GitHub OAuth secret are encrypted Cloudflare Worker secrets.
- OAuth authorization accepts only official ChatGPT and Claude callback origins. After GitHub login, the Worker shows the connector name, callback origin, and `amazon.read` scope and requires one explicit approval click. The approval POST ends on a same-origin handoff page before continuing to the connector, avoiding embedded Chromium's cross-origin form-redirect restriction.
- Amazon credentials are entered manually in Browserbase Live View. They never enter this repository, Cloudflare, ChatGPT, or Claude.
- Browserbase stores the Context's cookies and browser state encrypted at rest. Browserbase is therefore a deliberate third-party trust boundary.
- The one-time login session uses `persist: true`. Normal reads use `persist: false`, so browser reads cannot overwrite the saved login context.
- Session recording, session logging, automated CAPTCHA solving, and keep-alive are explicitly disabled.
- The browser guard allows only read HTTP methods and reviewed Amazon order/sign-in/challenge paths. Site JavaScript is disabled during reads, and browser downloads are denied. Together with request interception, this blocks form submission, background writes, cart, checkout, buying, cancellation, returns, reviews, wishlists, settings, popups, downloads, and unapproved hosts.
- Returned fields are limited to order IDs, dates, totals, statuses, item titles, ASINs, quantities, shipments, and price breakdowns.
- Delivery addresses, recipient names, payment instruments, email, phone, tracking numbers, messages, URLs, raw HTML, screenshots, and cookies are excluded.
- Site strings are normalized, length-limited, marked as untrusted web data, and never interpreted by an inner LLM.

Tool annotations describe all four tools as read-only, but enforcement is also implemented in exact request and response schemas, fixed URL construction, request interception, disabled site JavaScript, deterministic parsing, and the absence of browser primitives.

## Prerequisites

- Bun 1.3+
- Node.js 22+ for Wrangler and the Browserbase CLI
- A Cloudflare account
- A Browserbase account and API key
- A GitHub OAuth app
- A dedicated Browserbase Context containing a manually authenticated Amazon session

Amazon is bot-protected. A free Browserbase plan may present a challenge or block login because proxies, Verified sessions, and automated CAPTCHA solving are paid features. It also has a browser-minute allowance; live MCP reads stop when that allowance is exhausted and return `BROWSER_QUOTA_EXHAUSTED`. This connector intentionally does not bypass challenges; it returns `CHALLENGE_REQUIRED` so the user can resolve access manually or change the Browserbase plan.

## Local setup

Install dependencies:

```bash
bun install
```

Install Browserbase's unified CLI if needed:

```bash
npm install -g browse@latest
```

Keep the Browserbase key in the shell, never in source:

```bash
export BROWSERBASE_API_KEY=bb_live_replace_me
browse cloud projects list
```

The API key resolves its project automatically. Do not configure or request a separate Browserbase project ID.

### Create the dedicated Amazon Context

Create one context per site and login:

```bash
browse cloud contexts create --name amazon-primary
```

Start a one-time manual-login session. This is the only session that persists changes:

```bash
browse cloud sessions create \
  --context-id amazon-primary \
  --persist \
  --no-record-session \
  --no-log-session \
  --no-solve-captchas \
  --region us-west-2 \
  --timeout 900 \
  --viewport 1440x1000
```

Open its Live View directly from the Browserbase dashboard, navigate to Amazon, and enter the Amazon password and MFA manually. Do not save the password in Chrome. Then release the session and wait several seconds for Context synchronization:

```bash
browse cloud sessions update FULL_SESSION_ID --status REQUEST_RELEASE
```

Production MCP tools never return a Live View URL. That URL is a short-lived browser-control capability and belongs only in the setup workflow.

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
bunx wrangler secret put BROWSERBASE_API_KEY
bunx wrangler secret put AMAZON_CONTEXT_ID
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
```

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
bunx wrangler deploy --dry-run
```

Tests use fictional handcrafted Amazon-like HTML only. Authenticated Amazon pages, cookies, Context data, and real order history must never be committed or used in CI fixtures.

Live QA is intentionally manual and limited:

1. Check `amazon_session_status`.
2. Read one order-history page with a small limit.
3. Compare order IDs, dates, totals, and item titles against Live View.
4. Confirm Browserbase retained no session recording or session logs.
5. Confirm address, payment, tracking, and raw-page fields never appear in MCP output.

## License

MIT
