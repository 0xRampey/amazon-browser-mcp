# Local Amazon browser agent

This primary runtime replaces only the Browserbase execution layer. The public
MCP endpoint, GitHub OAuth, tool schemas, deterministic parsers, and structured
outputs remain unchanged.

```text
Cloudflare Worker
  -> Workers VPC service binding
  -> outbound-only Cloudflare Tunnel
  -> 127.0.0.1:43218
  -> Bun local agent
  -> Playwright + dedicated Chromium profile
  -> fixed Amazon order pages
```

The Worker/VPC adapter is implemented in `src/browser/local-agent-executor.ts`.
The Worker signs each exact operation body, and both sides validate the same
request and response schemas.

## Security boundary

- Bun binds the HTTP server to `127.0.0.1`; hostname is not configurable.
- The only route is authenticated `POST /execute`.
- Its body must match one of the existing `session_status`, `list_orders`,
  `get_order`, or `find_orders` schemas.
- There is no URL, click, type, JavaScript, screenshot, download, cookie,
  password, raw-HTML, or raw-page endpoint.
- Production Chromium is headless with page JavaScript, service workers,
  downloads, popups, unsafe HTTP methods, subresources, and unapproved
  navigation disabled.
- Every successful result is checked against the existing exact MCP output
  schema before it leaves the process. Unexpected fields fail closed.
- Runtime errors and logs never include URLs, HTML, cookies, order content, or
  upstream exception text.
- Chromium uses a dedicated `0700` profile directory. The agent rejects the
  normal Chrome, Chromium, and Edge profile roots.

The one-time `login` command is the sole interactive exception. It opens the
fixed Amazon order-history URL, permits unsafe requests only to reviewed Amazon
authentication paths, and closes popups/downloads. The user types credentials
directly into Chrome. The code never receives them. Decline Chrome's password
save prompt; the launch configuration also disables its password-save bubble.
For a fail-closed guarantee, the agent removes Chrome's dedicated-profile
`Login Data*` password databases after login and before every production start.
The Cookies database that carries the Amazon session is left in place.

## Install

```bash
bun install
bun run local-agent:install-browser
```

`playwright-core` deliberately does not download a browser during dependency
installation. The second command installs Playwright's pinned Chromium build,
which appears as **Google Chrome for Testing** during the one-time login.

The default dedicated profile is:

```text
~/.amazon-browser-mcp/chrome-profile
```

It may be changed only to an absolute, non-browser-profile path:

```bash
export AMAZON_BROWSER_PROFILE_DIR="/absolute/private/path/chrome-profile"
```

Open the one-time headful login:

```bash
bun run local-agent:login
```

Sign into Amazon manually, do not save the password, verify that the Orders
page appears, and close the Chrome window.

Generate a separate request-authentication secret. Use the exact same value for
the local process and the Worker VPC adapter:

```bash
export LOCAL_BROWSER_AGENT_SECRET="$(openssl rand -hex 32)"
```

Run the local service:

```bash
bun run local-agent:serve
```

The port defaults to `43218`. An optional override must still be an
unprivileged local port:

```bash
export LOCAL_BROWSER_AGENT_PORT="43218"
```

## Cloudflare bridge

Create a remotely managed Cloudflare Tunnel for this agent. It needs no public
hostname or ingress route. Run `cloudflared` with the dashboard-issued tunnel
token, then create one Workers VPC HTTP service:

```bash
bunx wrangler vpc service create amazon-browser-mcp-local-agent \
  --type http \
  --tunnel-id YOUR_TUNNEL_ID \
  --ipv4 127.0.0.1 \
  --http-port 43218
```

Set that service ID as the `LOCAL_BROWSER_AGENT` VPC binding in the ignored
`wrangler.jsonc`. Keep `AMAZON_BROWSER_BACKEND` set to `local`. Generate one
32-byte-or-longer secret, store the same value as the Cloudflare Worker secret
`LOCAL_BROWSER_AGENT_SECRET` and as the local Keychain item described below,
then deploy the Worker.

## Signed request protocol

Required headers:

```text
X-Amazon-Agent-Timestamp: 13-digit Unix milliseconds
X-Amazon-Agent-Nonce: 16-128 base64url characters
X-Amazon-Agent-Signature: 64 lowercase hexadecimal characters
```

The timestamp must be within 60 seconds. A valid nonce is accepted once and is
retained in a bounded replay cache.

The signature is HMAC-SHA256 over this UTF-8 canonical value:

```text
amazon-local-agent-v1
TIMESTAMP
NONCE
POST
/execute
LOWERCASE_HEX_SHA256_OF_EXACT_BODY_BYTES
```

The shared secret is interpreted as its exact UTF-8 bytes and must contain
32-1024 bytes. The body is capped at 16 KiB before JSON parsing. The server
accepts at most eight outstanding operations—one running and up to seven
waiting—and runs them serially against the single persistent profile.

The reusable signer and verifier live in
`scripts/local-browser-agent/auth.ts`. The implemented Cloudflare adapter uses
the same Web Crypto protocol without adding a Node-only dependency.

## macOS launch-at-login templates

The files in `scripts/macos/` are reusable user LaunchAgent templates. They
contain only paths and fixed configuration—never a secret or tunnel token.
Their wrappers read these generic-password items at runtime:

```text
account: current macOS username
service: amazon-browser-mcp/LOCAL_BROWSER_AGENT_SECRET
service: amazon-browser-mcp/CLOUDFLARE_TUNNEL_TOKEN
```

Store both items in the login Keychain and grant `/usr/bin/security` access so
launch-at-login does not show a password prompt. The local agent secret can be
generated rather than chosen by the user. The Cloudflare tunnel token comes
from the remotely managed Workers VPC tunnel.

Before installing, copy each template to `~/Library/LaunchAgents/` and replace:

- `__REPOSITORY_PATH__` with this repository's absolute path
- `__BUN_PATH__` with `command -v bun`
- `__CLOUDFLARED_PATH__` with `command -v cloudflared`

Validate the generated plists:

```bash
plutil -lint ~/Library/LaunchAgents/com.amazon-browser-mcp.agent.plist
plutil -lint ~/Library/LaunchAgents/com.amazon-browser-mcp.tunnel.plist
```

Load them without `sudo`:

```bash
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.amazon-browser-mcp.agent.plist
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.amazon-browser-mcp.tunnel.plist
```

Remove them without affecting the dedicated Chromium profile:

```bash
launchctl bootout "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.amazon-browser-mcp.agent.plist
launchctl bootout "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.amazon-browser-mcp.tunnel.plist
rm ~/Library/LaunchAgents/com.amazon-browser-mcp.agent.plist
rm ~/Library/LaunchAgents/com.amazon-browser-mcp.tunnel.plist
```

The tunnel wrapper writes the token to a private temporary file because
`cloudflared --token-file` keeps it out of process arguments. The file is
deleted whenever the wrapper exits. Both LaunchAgents discard stdout/stderr so
Chrome or tunnel diagnostics cannot become unattended page-derived log files.

## Verification

```bash
bun run typecheck:local
bun run local-agent:test
bun run check
```

Tests use only fictional operation values and fakes. They do not launch Chrome,
touch the dedicated profile, or contact Amazon.
