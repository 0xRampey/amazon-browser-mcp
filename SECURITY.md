# Security policy

## Supported scope

This server is a private, single-user, read-only Amazon order connector. Do not add generic browser primitives or write-capable Amazon tools to this deployment.

## Secrets

Never commit or print:

- `BROWSERBASE_API_KEY`
- `AMAZON_CONTEXT_ID`
- `GITHUB_CLIENT_SECRET`
- OAuth access or refresh tokens
- Browserbase connection or Live View URLs
- Cookies, storage state, raw page HTML, screenshots, or authenticated fixtures

Use a dedicated `OAUTH_KV` namespace for this Worker. Reusing a namespace with another OAuth provider can mix client, grant, token, and transient-state records across deployments.

Rotate the Browserbase key and revoke the Amazon Context if either may have leaked. Revoke the GitHub OAuth app and Worker grants if connector authorization may have leaked.

## Data boundary

Browserbase stores the dedicated Chromium Context, which contains reusable Amazon authentication state. It is encrypted at rest but remains equivalent to a logged-in browser profile. Production reads must use `persist: false`, and only one session may use the Context at a time.

Amazon-derived strings are untrusted data. The parser must remain deterministic and allowlisted; it must never send page content to an LLM or return raw DOM/page text.

Production reads disable site JavaScript and browser downloads before navigating. Do not relax either control merely to accommodate layout drift; review and test any narrower exception against the read-only network policy first.

OAuth dynamically registers only clients whose redirect URIs are on the official ChatGPT or Claude origins, revalidates that origin during authorization, requires explicit consent, and embeds the `amazon.read` grant in protected token properties. Dynamic registration remains a public protocol endpoint and can still receive abusive registration traffic; use Cloudflare rate limiting if that becomes operationally material.

## Vulnerability reports

Open a private GitHub security advisory on the repository. Do not include real credentials, cookies, order data, or Live View links in a report.
