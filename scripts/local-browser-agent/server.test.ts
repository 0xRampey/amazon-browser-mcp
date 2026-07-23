import { describe, expect, it, vi } from "vitest";

import { signLocalAgentRequest } from "./auth";
import {
  LOCAL_AGENT_MAX_BODY_BYTES,
  createLocalAgentHandler,
} from "./server";
import { AmazonOperationError } from "../../src/sites/amazon/operations";

const SECRET = "s".repeat(64);
const NOW = 1_800_000_000_000;
let nonceCounter = 0;

async function signedRequest(
  value: unknown,
  overrides: { path?: string; body?: string; timestamp?: number } = {},
): Promise<Request> {
  const body = overrides.body ?? JSON.stringify(value);
  const bytes = new TextEncoder().encode(body);
  const path = overrides.path ?? "/execute";
  nonceCounter += 1;
  const authentication = await signLocalAgentRequest({
    secret: SECRET,
    body: bytes,
    path,
    timestamp: overrides.timestamp ?? NOW,
    nonce: `nonce_${String(nonceCounter).padStart(20, "0")}`,
  });
  return new Request(`http://127.0.0.1:43218${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authentication,
    },
    body,
  });
}

describe("local browser agent HTTP boundary", () => {
  it("accepts a signed typed operation and validates the exact output", async () => {
    const execute = vi.fn(async () => ({
      state: "authenticated",
      profile_alias: "amazon-primary",
      checked_at: "2026-07-23T12:00:00.000Z",
    }));
    const handler = createLocalAgentHandler({ secret: SECRET, execute, now: () => NOW });
    const response = await handler(
      await signedRequest({ action: "session_status" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        state: "authenticated",
        profile_alias: "amazon-primary",
        checked_at: "2026-07-23T12:00:00.000Z",
      },
    });
    expect(execute).toHaveBeenCalledWith({ action: "session_status" });
  });

  it("allows only the four existing operation schemas", async () => {
    const seen: string[] = [];
    const execute = vi.fn(async (operation) => {
      seen.push(operation.action);
      if (operation.action === "session_status") {
        return {
          state: "authenticated",
          profile_alias: "amazon-primary",
          checked_at: "2026-07-23T12:00:00.000Z",
        };
      }
      if (operation.action === "list_orders") return { orders: [], has_more: false };
      if (operation.action === "find_orders") return { status: "none", candidates: [] };
      throw new AmazonOperationError("NOT_FOUND");
    });
    const handler = createLocalAgentHandler({ secret: SECRET, execute, now: () => NOW });
    const operations = [
      { action: "session_status" },
      { action: "list_orders", limit: 5, maxPages: 1 },
      { action: "get_order", orderId: "123-1234567-1234567" },
      {
        action: "find_orders",
        amount: "41.92",
        currency: "USD",
        dateWindowDays: 0,
        amountTolerance: "0.00",
        limit: 5,
        maxPages: 1,
      },
    ] as const;

    for (const operation of operations) {
      const response = await handler(await signedRequest(operation));
      expect([200, 404]).toContain(response.status);
    }
    expect(seen).toEqual([
      "session_status",
      "list_orders",
      "get_order",
      "find_orders",
    ]);

    const genericBrowserOperation = await handler(
      await signedRequest({ action: "open_url", url: "https://example.com" }),
    );
    expect(genericBrowserOperation.status).toBe(400);
    expect(seen).toHaveLength(4);
  });

  it("rejects unsigned, replayed, tampered, or stale requests", async () => {
    const execute = vi.fn();
    const handler = createLocalAgentHandler({ secret: SECRET, execute, now: () => NOW });

    const unsigned = new Request("http://127.0.0.1:43218/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"action":"session_status"}',
    });
    expect((await handler(unsigned)).status).toBe(401);

    const replaySource = await signedRequest({ action: "session_status" });
    const replayBody = await replaySource.text();
    const replayHeaders = new Headers(replaySource.headers);
    const first = new Request(replaySource.url, {
      method: "POST",
      headers: replayHeaders,
      body: replayBody,
    });
    const second = new Request(replaySource.url, {
      method: "POST",
      headers: replayHeaders,
      body: replayBody,
    });
    expect((await handler(first)).status).not.toBe(401);
    execute.mockClear();
    expect((await handler(second)).status).toBe(401);

    const tampered = await signedRequest(
      { action: "session_status" },
      { body: '{"action":"list_orders","limit":1,"maxPages":1}' },
    );
    tampered.headers.set("x-amazon-agent-signature", "0".repeat(64));
    expect((await handler(tampered)).status).toBe(401);

    const stale = await signedRequest(
      { action: "session_status" },
      { timestamp: NOW - 60_001 },
    );
    expect((await handler(stale)).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects alternate paths, methods, content types, and oversized bodies", async () => {
    const handler = createLocalAgentHandler({
      secret: SECRET,
      execute: vi.fn(),
      now: () => NOW,
    });

    expect(
      (
        await handler(
          new Request("http://127.0.0.1:43218/health", { method: "GET" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handler(
          new Request("http://127.0.0.1:43218/execute", { method: "GET" }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handler(
          new Request("http://127.0.0.1:43218/execute", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handler(
          new Request("http://127.0.0.1:43218/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "x".repeat(LOCAL_AGENT_MAX_BODY_BYTES + 1),
          }),
        )
      ).status,
    ).toBe(413);
  });

  it("drops unexpected output fields and raw exception diagnostics", async () => {
    const leakingOutput = createLocalAgentHandler({
      secret: SECRET,
      now: () => NOW,
      execute: async () => ({
        state: "authenticated",
        profile_alias: "amazon-primary",
        checked_at: "2026-07-23T12:00:00.000Z",
        cookies: "private-cookie",
      }),
    });
    const outputResponse = await leakingOutput(
      await signedRequest({ action: "session_status" }),
    );
    const outputText = await outputResponse.text();
    expect(outputResponse.status).toBe(503);
    expect(outputText).not.toContain("private-cookie");
    expect(outputText).not.toContain("cookies");

    const throwing = createLocalAgentHandler({
      secret: SECRET,
      now: () => NOW,
      execute: async () => {
        throw new Error("<html>real order page</html> cookie=secret");
      },
    });
    const errorResponse = await throwing(
      await signedRequest({ action: "session_status" }),
    );
    const errorText = await errorResponse.text();
    expect(errorResponse.status).toBe(503);
    expect(errorText).not.toContain("real order page");
    expect(errorText).not.toContain("cookie");
  });
});
