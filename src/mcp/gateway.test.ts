import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { AmazonGatewayError, DurableObjectAmazonGateway } from "./gateway";

function environment(response: Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  const stub = { fetch };
  const id = {} as DurableObjectId;
  const namespace = {
    idFromName: vi.fn(() => id),
    get: vi.fn(() => stub),
  };

  return {
    env: { AMAZON_BROWSER: namespace } as unknown as Env,
    fetch,
    namespace,
  };
}

describe("DurableObjectAmazonGateway", () => {
  it("calls the single named Amazon object and returns structured data", async () => {
    const { env, fetch, namespace } = environment(
      Response.json({
        ok: true,
        data: {
          state: "authenticated",
          profile_alias: "amazon-primary",
          checked_at: "2026-07-21T00:00:00.000Z",
        },
      }),
    );
    const gateway = new DurableObjectAmazonGateway(env);

    await expect(gateway.execute({ action: "session_status" })).resolves.toEqual({
      state: "authenticated",
      profile_alias: "amazon-primary",
      checked_at: "2026-07-21T00:00:00.000Z",
    });
    expect(namespace.idFromName).toHaveBeenCalledWith("amazon-primary");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://amazon-browser.internal/execute");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ action: "session_status" });
  });

  it("preserves only a typed safe error from the internal object", async () => {
    const { env } = environment(
      Response.json(
        {
          ok: false,
          error: {
            code: "LOGIN_REQUIRED",
            message: "private upstream message with wss://connect.browserbase.com/secret",
            userActionRequired: true,
          },
        },
        { status: 401 },
      ),
    );

    const error = await new DurableObjectAmazonGateway(env)
      .execute({ action: "session_status" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmazonGatewayError);
    expect(error).toMatchObject({
      code: "LOGIN_REQUIRED",
      message: "Amazon sign-in is required.",
      userActionRequired: true,
    });
    expect(String(error)).not.toContain("connect.browserbase.com");
  });

  it("sanitizes malformed internal responses", async () => {
    const { env } = environment(new Response("private browser failure", { status: 500 }));

    const error = await new DurableObjectAmazonGateway(env)
      .execute({ action: "session_status" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmazonGatewayError);
    expect(String(error)).not.toContain("private browser failure");
  });

  it("rejects extra private fields in an otherwise valid tool payload", async () => {
    const { env } = environment(
      Response.json({
        ok: true,
        data: {
          state: "authenticated",
          profile_alias: "amazon-primary",
          checked_at: "2026-07-21T00:00:00.000Z",
          connect_url: "wss://connect.browserbase.com/private",
        },
      }),
    );

    const error = await new DurableObjectAmazonGateway(env)
      .execute({ action: "session_status" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "TEMPORARY_FAILURE" });
    expect(String(error)).not.toContain("connect.browserbase.com");
  });

  it("does not trust an unknown internal error code or message", async () => {
    const { env } = environment(
      Response.json(
        {
          ok: false,
          error: {
            code: "RAW_VENDOR_ERROR",
            message: "bb_live_secret context_secret raw html",
          },
        },
        { status: 503 },
      ),
    );

    const error = await new DurableObjectAmazonGateway(env)
      .execute({ action: "session_status" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "TEMPORARY_FAILURE",
      message: "The Amazon browser service is temporarily unavailable.",
    });
    expect(String(error)).not.toContain("bb_live_secret");
  });
});
