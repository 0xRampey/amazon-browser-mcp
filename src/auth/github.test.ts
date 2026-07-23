import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import {
  constantTimeEqual,
  githubAuthorizationHandler,
  hashState,
  validateConnectorRegistration,
} from "./github";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub OAuth state helpers", () => {
  it("hashes deterministically without retaining the state", async () => {
    const first = await hashState("state-one");
    const second = await hashState("state-one");
    const different = await hashState("state-two");

    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("state-one");
  });

  it("compares equal and unequal values", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });
});

describe("connector client policy", () => {
  it("allows only official ChatGPT and Claude callback origins at registration", () => {
    expect(
      validateConnectorRegistration({
        clientMetadata: {
          client_name: "ChatGPT",
          redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
        },
        request: new Request("https://worker.example/oauth/register", { method: "POST" }),
      }),
    ).toBeUndefined();

    expect(
      validateConnectorRegistration({
        clientMetadata: {
          client_name: "Spoofed connector",
          redirect_uris: ["https://chatgpt.com.evil.example/callback"],
        },
        request: new Request("https://worker.example/oauth/register", { method: "POST" }),
      }),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
  });

  it("rejects an untrusted authorization redirect before creating state", async () => {
    const { env, put } = testEnvironment({
      redirectUri: "https://evil.example/callback",
      clientRedirectUris: ["https://evil.example/callback"],
    });

    const response = await githubAuthorizationHandler.fetch(
      new Request("https://worker.example/authorize"),
      env,
    );

    expect(response.status).toBe(403);
    expect(put).not.toHaveBeenCalled();
    expect(response.headers.get("Location")).toBeNull();
  });

  it("requires the exact amazon.read scope before creating state", async () => {
    const { env, put } = testEnvironment({ scopes: [] });

    const response = await githubAuthorizationHandler.fetch(
      new Request("https://worker.example/authorize"),
      env,
    );

    expect(response.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    expect(response.headers.get("Location")).toBeNull();
  });

  it("requires GitHub identity and explicit consent before granting amazon.read", async () => {
    const { env, completeAuthorization } = testEnvironment();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "github-token" }))
      .mockResolvedValueOnce(Response.json({ id: 2914233, login: "allowed-user" }));
    vi.stubGlobal("fetch", fetchMock);

    const start = await githubAuthorizationHandler.fetch(
      new Request("https://worker.example/authorize"),
      env,
    );
    expect(start.status).toBe(302);
    const githubLocation = new URL(start.headers.get("Location")!);
    const githubState = githubLocation.searchParams.get("state")!;
    const stateSetCookie = start.headers.getSetCookie()[0]!;
    expect(stateSetCookie).toContain("HttpOnly");
    expect(stateSetCookie).toContain("Secure");
    expect(stateSetCookie).toContain("SameSite=Lax");
    expect(stateSetCookie).toContain("Max-Age=900");
    const stateCookie = stateSetCookie.split(";", 1)[0]!;

    const callback = await githubAuthorizationHandler.fetch(
      new Request(
        `https://worker.example/callback?state=${encodeURIComponent(githubState)}&code=github-code`,
        { headers: { Cookie: stateCookie } },
      ),
      env,
    );
    expect(callback.status).toBe(200);
    expect(await callback.clone().text()).toContain("Allow read-only access");
    expect(callback.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' https://chatgpt.com",
    );
    expect(callback.headers.get("Content-Security-Policy")).not.toContain("https://claude.ai");
    expect(completeAuthorization).not.toHaveBeenCalled();

    const consentHtml = await callback.text();
    const consentState = consentHtml.match(/name="consent_state" value="([^"]+)"/u)?.[1];
    expect(consentState).toBeTruthy();
    expect(callback.headers.getSetCookie()).toEqual([]);
    const approval = await githubAuthorizationHandler.fetch(
      new Request("https://worker.example/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: stateCookie,
        },
        body: new URLSearchParams({ consent_state: consentState!, decision: "allow" }),
      }),
      env,
    );

    expect(approval.status).toBe(200);
    expect(approval.headers.get("Location")).toBeNull();
    expect(await approval.clone().text()).toContain(
      'href="https://chatgpt.com/connector/complete"',
    );
    expect(approval.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' https://chatgpt.com",
    );
    expect(approval.headers.getSetCookie()).toEqual([
      expect.stringContaining("__Host-AMAZON_BROWSER_GITHUB_STATE=;"),
    ]);
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "2914233",
        scope: ["amazon.read"],
        props: {
          githubLogin: "allowed-user",
          githubUserId: "2914233",
          amazonRead: true,
        },
      }),
    );
  });

  it("rejects a consent POST without the original browser binding", async () => {
    const { env, completeAuthorization } = testEnvironment();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ access_token: "github-token" }))
        .mockResolvedValueOnce(Response.json({ id: 2914233, login: "allowed-user" })),
    );

    const start = await githubAuthorizationHandler.fetch(
      new Request("https://worker.example/authorize"),
      env,
    );
    const githubLocation = new URL(start.headers.get("Location")!);
    const callback = await githubAuthorizationHandler.fetch(
      new Request(
        `https://worker.example/callback?state=${encodeURIComponent(githubLocation.searchParams.get("state")!)}&code=github-code`,
        { headers: { Cookie: start.headers.getSetCookie()[0]!.split(";", 1)[0]! } },
      ),
      env,
    );
    const consentState = (await callback.text()).match(
      /name="consent_state" value="([^"]+)"/u,
    )?.[1];

    const approval = await githubAuthorizationHandler.fetch(
      new Request("https://worker.example/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-AMAZON_BROWSER_GITHUB_STATE=${"0".repeat(64)}`,
        },
        body: new URLSearchParams({ consent_state: consentState!, decision: "allow" }),
      }),
      env,
    );

    expect(approval.status).toBe(400);
    expect(approval.headers.getSetCookie()).toEqual([]);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("does not clear a login state cookie for an unbound cancellation callback", async () => {
    const { env } = testEnvironment();
    const response = await githubAuthorizationHandler.fetch(
      new Request("https://worker.example/callback?error=access_denied"),
      env,
    );

    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

function testEnvironment(
  options: {
    redirectUri?: string;
    clientRedirectUris?: string[];
    scopes?: string[];
  } = {},
) {
  const values = new Map<string, string>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const remove = vi.fn(async (key: string) => {
    values.delete(key);
  });
  const redirectUri = options.redirectUri ?? "https://chatgpt.com/connector/oauth/callback";
  const authRequest = {
    responseType: "code",
    clientId: "connector-client",
    redirectUri,
    scope: options.scopes ?? ["amazon.read"],
    state: "client-state",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
  };
  const client = {
    clientId: "connector-client",
    clientName: "ChatGPT",
    redirectUris: options.clientRedirectUris ?? [redirectUri],
  };
  const completeAuthorization = vi.fn(async () => ({
    redirectTo: "https://chatgpt.com/connector/complete",
  }));
  const oauthProvider = {
    parseAuthRequest: vi.fn(async () => authRequest),
    lookupClient: vi.fn(async () => client),
    completeAuthorization,
  };

  const env = {
    OAUTH_KV: { get, put, delete: remove },
    OAUTH_PROVIDER: oauthProvider,
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    ALLOWED_GITHUB_USER_ID: "2914233",
  } as unknown as Env;

  return { env, get, put, remove, completeAuthorization };
}
