import type {
  AuthRequest,
  ClientInfo,
  ClientRegistrationCallbackOptions,
  ClientRegistrationCallbackResult,
} from "@cloudflare/workers-oauth-provider";

import type { Env } from "../env";

const STATE_PREFIX = "github-oauth-state:";
const CONSENT_PREFIX = "github-oauth-consent:";
const STATE_COOKIE = "__Host-AMAZON_BROWSER_GITHUB_STATE";
const STATE_TTL_SECONDS = 600;
const CONSENT_TTL_SECONDS = 900;
const REQUIRED_SCOPE = "amazon.read";
const MAX_CONSENT_BODY_BYTES = 4 * 1024;

const TRUSTED_CONNECTOR_REDIRECT_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
  "https://claude.ai",
]);

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
}

interface GitHubUser {
  id: number;
  login: string;
}

interface PendingConsent {
  authRequest: AuthRequest;
  githubUser: GitHubUser;
  clientName: string;
  redirectOrigin: string;
  browserBindingHash: string;
}

export const githubAuthorizationHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" && request.method === "GET") {
      return startGitHubAuthorization(request, env);
    }

    if (url.pathname === "/callback" && request.method === "GET") {
      return finishGitHubAuthorization(request, env);
    }

    if (url.pathname === "/approve" && request.method === "POST") {
      return finishConnectorConsent(request, env);
    }

    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return htmlResponse(homePage(), 200, request.method === "HEAD");
    }

    return new Response("Not found", { status: 404, headers: securityHeaders });
  },
} satisfies ExportedHandler<Env>;

async function startGitHubAuthorization(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID) {
    return htmlResponse(errorPage("GitHub OAuth is not configured yet."), 503);
  }

  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return htmlResponse(errorPage("Invalid OAuth authorization request."), 400);
  }

  const client = authRequest.clientId
    ? await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId)
    : null;
  if (!client) {
    return htmlResponse(errorPage("Unknown OAuth client."), 400);
  }
  if (!isTrustedAuthorizationRequest(authRequest, client)) {
    return htmlResponse(errorPage("This connector client is not allowed."), 403);
  }
  if (!hasSupportedScopes(authRequest.scope)) {
    return htmlResponse(errorPage("This connector requested an unsupported permission."), 400);
  }

  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`${STATE_PREFIX}${state}`, JSON.stringify(authRequest), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
  githubUrl.searchParams.set("scope", "read:user");
  githubUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      ...securityHeaders,
      Location: githubUrl.href,
      "Set-Cookie": await stateCookie(state),
    },
  });
}

async function finishGitHubAuthorization(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  if (!state) {
    return htmlResponse(errorPage("GitHub returned an incomplete authorization response."), 400);
  }

  const storedRequest = await env.OAUTH_KV.get(`${STATE_PREFIX}${state}`);
  await env.OAUTH_KV.delete(`${STATE_PREFIX}${state}`);

  const cookieHash = getCookie(request, STATE_COOKIE);
  const expectedHash = await hashState(state);
  if (!storedRequest || !cookieHash || !constantTimeEqual(cookieHash, expectedHash)) {
    return htmlResponse(
      errorPage("This authorization session is invalid or expired. Start the connection again."),
      400,
      false,
      clearStateCookie(),
    );
  }

  if (url.searchParams.has("error")) {
    return htmlResponse(
      errorPage("GitHub authorization was cancelled."),
      400,
      false,
      clearStateCookie(),
    );
  }
  if (!code) {
    return htmlResponse(
      errorPage("GitHub returned an incomplete authorization response."),
      400,
      false,
      clearStateCookie(),
    );
  }

  let authRequest: AuthRequest;
  try {
    authRequest = JSON.parse(storedRequest) as AuthRequest;
  } catch {
    return htmlResponse(errorPage("The stored authorization request is invalid."), 500);
  }

  const client = authRequest.clientId
    ? await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId)
    : null;
  if (!client || !isTrustedAuthorizationRequest(authRequest, client)) {
    return htmlResponse(
      errorPage("This connector client is not allowed."),
      403,
      false,
      clearStateCookie(),
    );
  }
  if (!hasSupportedScopes(authRequest.scope)) {
    return htmlResponse(
      errorPage("This connector requested an unsupported permission."),
      400,
      false,
      clearStateCookie(),
    );
  }

  try {
    const accessToken = await exchangeGitHubCode(code, request.url, env);
    const githubUser = await getGitHubUser(accessToken);

    if (String(githubUser.id) !== env.ALLOWED_GITHUB_USER_ID) {
      return htmlResponse(
        errorPage(`GitHub user @${githubUser.login} is not allowed to access this connector.`),
        403,
        false,
        clearStateCookie(),
      );
    }

    const consentState = crypto.randomUUID();
    const pending: PendingConsent = {
      authRequest,
      githubUser,
      clientName: safeClientName(client),
      redirectOrigin: new URL(authRequest.redirectUri).origin,
      browserBindingHash: expectedHash,
    };
    await env.OAUTH_KV.put(`${CONSENT_PREFIX}${consentState}`, JSON.stringify(pending), {
      expirationTtl: CONSENT_TTL_SECONDS,
    });

    return htmlResponse(
      consentPage(pending, consentState),
      200,
      false,
      undefined,
      connectorConsentSecurityHeaders(pending.redirectOrigin),
    );
  } catch {
    return htmlResponse(
      errorPage("GitHub authentication could not be completed."),
      502,
      false,
      clearStateCookie(),
    );
  }
}

async function finishConnectorConsent(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(contentType)) {
    return htmlResponse(errorPage("Invalid approval request."), 415);
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_CONSENT_BODY_BYTES)) {
    return htmlResponse(errorPage("Invalid approval request."), 413);
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return htmlResponse(errorPage("Invalid approval request."), 400);
  }
  if (new TextEncoder().encode(body).byteLength > MAX_CONSENT_BODY_BYTES) {
    return htmlResponse(errorPage("Invalid approval request."), 413);
  }

  const form = new URLSearchParams(body);
  const consentState = form.get("consent_state");
  const decision = form.get("decision");
  if (!consentState || (decision !== "allow" && decision !== "deny")) {
    return htmlResponse(errorPage("Invalid approval request."), 400);
  }

  const stored = await env.OAUTH_KV.get(`${CONSENT_PREFIX}${consentState}`);
  await env.OAUTH_KV.delete(`${CONSENT_PREFIX}${consentState}`);
  if (!stored) {
    return htmlResponse(
      errorPage("This approval session is invalid or expired. Start the connection again."),
      400,
    );
  }

  const pending = parsePendingConsent(stored);
  if (!pending) {
    return htmlResponse(errorPage("The stored approval request is invalid."), 500);
  }
  const browserBinding = getCookie(request, STATE_COOKIE);
  if (!browserBinding || !constantTimeEqual(browserBinding, pending.browserBindingHash)) {
    return htmlResponse(
      errorPage("This approval session is invalid or expired. Start the connection again."),
      400,
    );
  }
  const client = pending.authRequest.clientId
    ? await env.OAUTH_PROVIDER.lookupClient(pending.authRequest.clientId)
    : null;
  if (
    !client ||
    !isTrustedAuthorizationRequest(pending.authRequest, client) ||
    !hasSupportedScopes(pending.authRequest.scope) ||
    String(pending.githubUser.id) !== env.ALLOWED_GITHUB_USER_ID
  ) {
    return htmlResponse(errorPage("This connector approval is no longer valid."), 403, false, clearStateCookie());
  }

  if (decision === "deny") {
    return htmlResponse(errorPage("Connector access was not approved."), 403, false, clearStateCookie());
  }

  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: pending.authRequest,
      userId: String(pending.githubUser.id),
      metadata: { label: `GitHub @${pending.githubUser.login}` },
      scope: [REQUIRED_SCOPE],
      props: {
        githubLogin: pending.githubUser.login,
        githubUserId: String(pending.githubUser.id),
        amazonRead: true,
      },
    });

    return htmlResponse(
      authorizationCompletePage(redirectTo),
      200,
      false,
      clearStateCookie(),
      connectorConsentSecurityHeaders(pending.redirectOrigin),
    );
  } catch {
    return htmlResponse(
      errorPage("Connector authorization could not be completed."),
      502,
      false,
      clearStateCookie(),
    );
  }
}

async function exchangeGitHubCode(code: string, requestUrl: string, env: Env): Promise<string> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error("GitHub OAuth is not configured yet.");
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", requestUrl).href,
    }),
  });

  const result = (await response.json()) as GitHubTokenResponse;
  if (!response.ok || !result.access_token) {
    throw new Error(`GitHub rejected the OAuth token exchange${result.error ? `: ${result.error}` : "."}`);
  }

  return result.access_token;
}

async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "amazon-browser-mcp-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user lookup failed with HTTP ${response.status}.`);
  }

  const user = (await response.json()) as Partial<GitHubUser>;
  if (typeof user.id !== "number" || typeof user.login !== "string") {
    throw new Error("GitHub returned an invalid user profile.");
  }

  return user as GitHubUser;
}

async function stateCookie(state: string): Promise<string> {
  const value = await hashState(state);
  return `${STATE_COOKIE}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${CONSENT_TTL_SECONDS}`;
}

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

function getCookie(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  const prefix = `${name}=`;
  return cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(prefix))?.slice(prefix.length);
}

export async function hashState(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return difference === 0;
}

function htmlResponse(
  body: string,
  status = 200,
  omitBody = false,
  cookies?: string | string[],
  headerOverrides?: HeadersInit,
): Response {
  const headers = new Headers({
    ...securityHeaders,
    ...headerOverrides,
    "Content-Type": "text/html; charset=utf-8",
  });
  for (const cookie of typeof cookies === "string" ? [cookies] : (cookies ?? [])) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(omitBody ? null : body, { status, headers });
}

function connectorConsentSecurityHeaders(redirectOrigin: string): HeadersInit {
  return {
    ...securityHeaders,
    // Chromium applies form-action across a form submission's redirect chain.
    // The origin was already restricted to the exact registered connector
    // callback, so permit only that origin in addition to the same-origin POST.
    "Content-Security-Policy":
      `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${redirectOrigin}`,
  };
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Amazon Browser MCP</title></head><body><h1>Could not connect Amazon Browser MCP</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function homePage(): string {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Amazon Browser MCP</title></head><body><h1>Amazon Browser MCP</h1><p>Private, read-only Amazon order connector. The MCP endpoint is <code>/mcp</code> and authorization uses GitHub.</p></body></html>";
}

function authorizationCompletePage(redirectTo: string): string {
  const destination = escapeHtml(redirectTo);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${destination}"><title>Amazon Browser MCP approved</title></head><body><h1>Read-only access approved</h1><p>Continuing to your connector.</p><p><a href="${destination}">Continue to connector</a></p></body></html>`;
}

function consentPage(pending: PendingConsent, consentState: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Approve Amazon Browser MCP</title></head><body><h1>Approve read-only Amazon access</h1><p><strong>${escapeHtml(pending.clientName)}</strong> is asking this Worker to read your Amazon order history through MCP.</p><p>After approval, the authorization result will return only to <code>${escapeHtml(pending.redirectOrigin)}</code>.</p><p>This grants <code>${REQUIRED_SCOPE}</code>. It does not grant browser clicks, forms, purchases, returns, account changes, cookies, passwords, or raw page access.</p><form method="post" action="/approve"><input type="hidden" name="consent_state" value="${escapeHtml(consentState)}"><button type="submit" name="decision" value="allow">Allow read-only access</button> <button type="submit" name="decision" value="deny">Deny</button></form></body></html>`;
}

function isTrustedAuthorizationRequest(authRequest: AuthRequest, client: ClientInfo): boolean {
  return (
    authRequest.clientId === client.clientId &&
    typeof authRequest.redirectUri === "string" &&
    client.redirectUris.includes(authRequest.redirectUri) &&
    isTrustedRedirectUri(authRequest.redirectUri)
  );
}

function hasSupportedScopes(scopes: unknown): scopes is string[] {
  return (
    Array.isArray(scopes) &&
    scopes.length === 1 &&
    scopes.every((scope) => scope === REQUIRED_SCOPE) &&
    new Set(scopes).size === scopes.length
  );
}

function isTrustedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      TRUSTED_CONNECTOR_REDIRECT_ORIGINS.has(url.origin)
    );
  } catch {
    return false;
  }
}

function safeClientName(client: ClientInfo): string {
  const value = client.clientName?.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return value && value.length <= 100 ? value : "Connector client";
}

function parsePendingConsent(value: string): PendingConsent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const authRequest = Reflect.get(parsed, "authRequest");
  const githubUser = Reflect.get(parsed, "githubUser");
  const clientName = Reflect.get(parsed, "clientName");
  const redirectOrigin = Reflect.get(parsed, "redirectOrigin");
  const browserBindingHash = Reflect.get(parsed, "browserBindingHash");
  if (
    typeof authRequest !== "object" ||
    authRequest === null ||
    typeof Reflect.get(authRequest, "clientId") !== "string" ||
    typeof Reflect.get(authRequest, "redirectUri") !== "string" ||
    !hasSupportedScopes(Reflect.get(authRequest, "scope")) ||
    typeof githubUser !== "object" ||
    githubUser === null ||
    !Number.isSafeInteger(Reflect.get(githubUser, "id")) ||
    typeof Reflect.get(githubUser, "login") !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/u.test(Reflect.get(githubUser, "login") as string) ||
    typeof clientName !== "string" ||
    clientName.length < 1 ||
    clientName.length > 100 ||
    typeof redirectOrigin !== "string" ||
    !TRUSTED_CONNECTOR_REDIRECT_ORIGINS.has(redirectOrigin) ||
    typeof browserBindingHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(browserBindingHash)
  ) {
    return undefined;
  }
  return parsed as PendingConsent;
}

export function validateConnectorRegistration(
  options: ClientRegistrationCallbackOptions,
): ClientRegistrationCallbackResult | undefined {
  const redirectUris = options.clientMetadata.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length < 1 ||
    redirectUris.length > 4 ||
    !redirectUris.every((uri) => typeof uri === "string" && isTrustedRedirectUri(uri))
  ) {
    return {
      code: "invalid_redirect_uri",
      description: "Only approved ChatGPT and Claude connector callbacks are allowed.",
      status: 400,
    };
  }

  const clientName = options.clientMetadata.client_name;
  if (clientName !== undefined && (typeof clientName !== "string" || clientName.length > 100)) {
    return {
      code: "invalid_client_metadata",
      description: "The connector client name is invalid.",
      status: 400,
    };
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character] ?? character;
  });
}
