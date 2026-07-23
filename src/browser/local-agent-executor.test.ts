import { describe, expect, it, vi } from "vitest";

import {
  NonceReplayCache,
  verifyLocalAgentRequest,
} from "../../scripts/local-browser-agent/auth";
import type { Env } from "../env";
import { AmazonOperationError } from "../sites/amazon/operations";
import {
  executeLocalAmazonOperation,
  LOCAL_AGENT_OPERATION_URL,
  MAX_LOCAL_AGENT_RESPONSE_BYTES,
} from "./local-agent-executor";

const SECRET = "local-agent-test-secret-with-at-least-32-bytes";
const SESSION_STATUS = {
  state: "authenticated",
  profile_alias: "amazon-primary",
  checked_at: "2026-07-23T12:00:00.000Z",
} as const;

function environment(fetchImplementation: Fetcher["fetch"], secret = SECRET): Env {
  return {
    LOCAL_BROWSER_AGENT: {
      fetch: fetchImplementation,
    } as Fetcher,
    LOCAL_BROWSER_AGENT_SECRET: secret,
  } as Env;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

describe("local VPC Amazon operation executor", () => {
  it("signs the exact typed body and accepts only the expected operation output", async () => {
    const operation = { action: "session_status" } as const;
    const fetch = vi.fn<Fetcher["fetch"]>(async (input, init) => {
      const request = new Request(input, init);
      const body = new Uint8Array(await request.arrayBuffer());
      const authentication = await verifyLocalAgentRequest({
        secret: SECRET,
        headers: request.headers,
        body,
        method: request.method,
        path: new URL(request.url).pathname,
        replayCache: new NonceReplayCache(),
      });

      expect(request.url).toBe(LOCAL_AGENT_OPERATION_URL);
      expect(request.method).toBe("POST");
      expect(new TextDecoder().decode(body)).toBe(JSON.stringify(operation));
      expect(authentication).toEqual({ ok: true });

      return jsonResponse({ ok: true, data: SESSION_STATUS });
    });

    await expect(
      executeLocalAmazonOperation(environment(fetch), operation),
    ).resolves.toEqual(SESSION_STATUS);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps an allowlisted upstream failure to its fixed safe error", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: "LOGIN_REQUIRED",
            message:
              "private cookie and wss://connect.browserbase.com/upstream-details",
            userActionRequired: false,
          },
        },
        409,
      ),
    );

    const error = await executeLocalAmazonOperation(environment(fetch), {
      action: "session_status",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmazonOperationError);
    expect(error).toMatchObject({
      code: "LOGIN_REQUIRED",
      message: "Amazon sign-in is required.",
      userActionRequired: true,
    });
    expect(String(error)).not.toContain("connect.browserbase.com");
    expect(String(error)).not.toContain("cookie");
  });

  it("preserves QUEUE_FULL as a safe retryable operation failure", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: "QUEUE_FULL",
            message: "untrusted queue details",
          },
        },
        429,
      ),
    );

    await expect(
      executeLocalAmazonOperation(environment(fetch), {
        action: "session_status",
      }),
    ).rejects.toMatchObject({
      code: "QUEUE_FULL",
      message: "Too many Amazon operations are pending.",
      userActionRequired: false,
    });
  });

  it("maps VPC connection failures to a fixed Mac-agent action", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async () => {
      throw new Error("private tunnel and local filesystem diagnostics");
    });

    const error = await executeLocalAmazonOperation(environment(fetch), {
      action: "session_status",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "LOCAL_AGENT_UNAVAILABLE",
      message:
        "The local Amazon browser agent is unavailable. Start the Mac agent and try again.",
      userActionRequired: true,
    });
    expect(String(error)).not.toContain("filesystem");
    expect(String(error)).not.toContain("tunnel");
  });

  it.each([
    {
      name: "an unknown error code",
      response: jsonResponse(
        {
          ok: false,
          error: {
            code: "RAW_LOCAL_ERROR",
            message: "private profile path and cookie",
          },
        },
        503,
      ),
    },
    {
      name: "an extra private output field",
      response: jsonResponse({
        ok: true,
        data: {
          ...SESSION_STATUS,
          cookies: [{ name: "session-id", value: "private" }],
        },
      }),
    },
    {
      name: "a non-JSON response",
      response: new Response("private raw agent failure", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      }),
    },
    {
      name: "an oversized response",
      response: new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_LOCAL_AGENT_RESPONSE_BYTES + 1),
        },
      }),
    },
  ])("fails closed for $name", async ({ response }) => {
    const fetch = vi.fn<Fetcher["fetch"]>(async () => response);

    const error = await executeLocalAmazonOperation(environment(fetch), {
      action: "session_status",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "TEMPORARY_FAILURE",
      message: "The Amazon browser service is temporarily unavailable.",
      userActionRequired: false,
    });
    expect(String(error)).not.toContain("private");
    expect(String(error)).not.toContain("cookie");
  });

  it("does not treat an HTTP failure carrying success-shaped JSON as success", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async () =>
      jsonResponse({ ok: true, data: SESSION_STATUS }, 503),
    );

    await expect(
      executeLocalAmazonOperation(environment(fetch), {
        action: "session_status",
      }),
    ).rejects.toMatchObject({ code: "TEMPORARY_FAILURE" });
  });

  it("fails safely when the configured signing secret is invalid", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>();

    await expect(
      executeLocalAmazonOperation(environment(fetch, "short"), {
        action: "session_status",
      }),
    ).rejects.toMatchObject({ code: "LOCAL_AGENT_UNAVAILABLE" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
