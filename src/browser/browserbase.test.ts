import { describe, expect, it, vi } from "vitest";

import {
  BrowserbaseSessionError,
  buildCreateSessionBody,
  createBrowserbaseSession,
  DEFAULT_BROWSER_SESSION_TIMEOUT_SECONDS,
  MAX_BROWSER_SESSION_TIMEOUT_SECONDS,
  MIN_BROWSER_SESSION_TIMEOUT_SECONDS,
  normalizeSessionTimeout,
  releaseBrowserbaseSession,
} from "./browserbase";

const INPUT = {
  apiKey: "bb_test_secret",
  contextId: "ctx_amazon_123",
  region: "us-west-2" as const,
};

describe("buildCreateSessionBody", () => {
  it("builds the privacy-preserving production session request", () => {
    expect(buildCreateSessionBody(INPUT)).toEqual({
      browserSettings: {
        context: { id: "ctx_amazon_123", persist: false },
        recordSession: false,
        logSession: false,
        solveCaptchas: false,
      },
      timeout: DEFAULT_BROWSER_SESSION_TIMEOUT_SECONDS,
      keepAlive: false,
      region: "us-west-2",
      userMetadata: { integration: "amazon-orders-read" },
    });

    expect(buildCreateSessionBody(INPUT)).not.toHaveProperty("projectId");
    expect(JSON.stringify(buildCreateSessionBody(INPUT))).not.toContain(INPUT.apiKey);
  });

  it("uses the selected supported region", () => {
    expect(buildCreateSessionBody({ ...INPUT, region: "eu-central-1" }).region).toBe(
      "eu-central-1",
    );
  });

  it("rejects malformed credentials and context identifiers", () => {
    expect(() => buildCreateSessionBody({ ...INPUT, apiKey: "" })).toThrow(
      BrowserbaseSessionError,
    );
    expect(() => buildCreateSessionBody({ ...INPUT, contextId: " ctx secret " })).toThrow(
      BrowserbaseSessionError,
    );
  });
});

describe("normalizeSessionTimeout", () => {
  it("clamps sessions to the narrow production range", () => {
    expect(normalizeSessionTimeout(1)).toBe(MIN_BROWSER_SESSION_TIMEOUT_SECONDS);
    expect(normalizeSessionTimeout(120)).toBe(120);
    expect(normalizeSessionTimeout(99_999)).toBe(MAX_BROWSER_SESSION_TIMEOUT_SECONDS);
  });

  it("rejects fractional and non-finite timeout values", () => {
    expect(() => normalizeSessionTimeout(60.5)).toThrow(BrowserbaseSessionError);
    expect(() => normalizeSessionTimeout(Number.POSITIVE_INFINITY)).toThrow(
      BrowserbaseSessionError,
    );
  });
});

describe("createBrowserbaseSession", () => {
  it("uses raw REST fetch without a project ID and returns the internal connection", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          id: "session_123",
          connectUrl: "wss://connect.browserbase.com?signingKey=private",
          expiresAt: "2026-07-20T20:00:00.000Z",
        },
        { status: 201 },
      ),
    );

    const session = await createBrowserbaseSession(INPUT, { fetch: fetchMock });

    expect(session).toEqual({
      id: "session_123",
      connectUrl: "wss://connect.browserbase.com?signingKey=private",
      expiresAt: "2026-07-20T20:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.browserbase.com/v1/sessions");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("x-bb-api-key")).toBe(INPUT.apiKey);

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("projectId");
    expect(body).toMatchObject({
      browserSettings: {
        context: { id: INPUT.contextId, persist: false },
        recordSession: false,
        logSession: false,
        solveCaptchas: false,
      },
      keepAlive: false,
      region: INPUT.region,
    });
  });

  it.each([
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [402, "quota_exhausted"],
    [429, "rate_limited"],
    [400, "upstream_rejected"],
    [503, "upstream_unavailable"],
  ] as const)("maps HTTP %i to a sanitized %s error", async (status, code) => {
    const leakedBody = `private response ${INPUT.apiKey} ${INPUT.contextId}`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(leakedBody, { status }));

    const error = await createBrowserbaseSession(INPUT, { fetch: fetchMock }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BrowserbaseSessionError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(INPUT.apiKey);
    expect(String(error)).not.toContain(INPUT.contextId);
    expect(String(error)).not.toContain(leakedBody);
  });

  it("does not expose the upstream fetch error", async () => {
    const leakedMessage = `connect failed with ${INPUT.apiKey} and ${INPUT.contextId}`;
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(leakedMessage));

    const error = await createBrowserbaseSession(INPUT, { fetch: fetchMock }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "upstream_unavailable" });
    expect(String(error)).not.toContain(leakedMessage);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it.each([
    {},
    { id: "session_123" },
    { id: "session_123", connectUrl: "https://evil.example/session" },
    { id: "session_123", connectUrl: "wss://browserbase.com.evil.example/session" },
    { id: "session_123", connectUrl: "wss://user@connect.browserbase.com/session" },
  ])("rejects invalid or untrusted response payloads", async (payload) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(payload, { status: 201 }));

    await expect(createBrowserbaseSession(INPUT, { fetch: fetchMock })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("aborts a hung request at the caller-independent transport deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
      });
    });

    const promise = createBrowserbaseSession(INPUT, {
      fetch: fetchMock,
      requestTimeoutMs: 10,
    });
    const expectation = expect(promise).rejects.toMatchObject({ code: "request_timed_out" });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    vi.useRealTimers();
  });

  it("explicitly releases a session without a project ID", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ status: "COMPLETED" }),
    );

    await releaseBrowserbaseSession(
      { apiKey: INPUT.apiKey, sessionId: "session_123" },
      { fetch: fetchMock },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.browserbase.com/v1/sessions/session_123");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("x-bb-api-key")).toBe(INPUT.apiKey);
    expect(JSON.parse(String(init?.body))).toEqual({ status: "REQUEST_RELEASE" });
  });
});
