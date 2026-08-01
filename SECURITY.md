# Security policy

## Supported scope

This server is a private, single-user, read-only Amazon order connector. Do not add generic browser primitives or write-capable Amazon tools to this deployment.

## Secrets

Never commit or print:

- `BROWSERBASE_API_KEY`
- `AMAZON_CONTEXT_ID`
- `GITHUB_CLIENT_SECRET`
- `LOCAL_BROWSER_AGENT_SECRET`
- Cloudflare Tunnel tokens
- OAuth access or refresh tokens
- Browserbase connection or Live View URLs
- Local browser profiles, cookies, storage state, raw page HTML, screenshots,
  or authenticated fixtures

Use a dedicated `OAUTH_KV` namespace for this Worker. Reusing a namespace with another OAuth provider can mix client, grant, token, and transient-state records across deployments.

Rotate the local-agent HMAC secret and Tunnel token if either may have leaked.
Rotate the Browserbase key and revoke the Amazon Context if either fallback
credential may have leaked. Revoke the GitHub OAuth app and Worker grants if
connector authorization may have leaked.

## Data boundary

The primary runtime stores reusable Amazon authentication state only in a
dedicated local Chromium profile. That profile is equivalent to a logged-in
browser and must remain outside the repository with user-only filesystem
permissions. The code removes Chrome's `Login Data*` password databases before
and after interactive login and before every production start; it never exports
the Cookies database. The localhost agent accepts only signed, replay-protected
operations, and its Cloudflare Tunnel has no public hostname.

When the explicit Browserbase fallback is selected, Browserbase stores the
dedicated Chromium Context. It is encrypted at rest but remains equivalent to a
logged-in browser profile. Production fallback reads must use `persist: false`,
and only one session may use the Context at a time.

Amazon-derived strings are untrusted data. The parser must remain deterministic and allowlisted; it must never send page content to an LLM or return raw DOM/page text.

Production reads disable site JavaScript and browser downloads before navigating. Do not relax either control merely to accommodate layout drift; review and test any narrower exception against the read-only network policy first.

OAuth dynamically registers only clients whose redirect URIs are on the official ChatGPT or Claude origins, revalidates that origin during authorization, requires explicit consent, and embeds the `amazon.read` grant in protected token properties. Dynamic registration remains a public protocol endpoint and can still receive abusive registration traffic; use Cloudflare rate limiting if that becomes operationally material.

## Vulnerability reports

Open a private GitHub security advisory on the repository. Do not include real credentials, cookies, order data, or Live View links in a report.
