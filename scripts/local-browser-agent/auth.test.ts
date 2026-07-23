import { describe, expect, it } from "vitest";

import {
  NonceReplayCache,
  assertSecret,
  signLocalAgentRequest,
  verifyLocalAgentRequest,
} from "./auth";

const SECRET = "a".repeat(64);
const NOW = 1_800_000_000_000;
const NONCE = "nonce_1234567890abcdef";
const BODY = new TextEncoder().encode('{"action":"session_status"}');

describe("local browser agent request authentication", () => {
  it("accepts one fresh signature over the exact body and endpoint", async () => {
    const headers = new Headers(
      await signLocalAgentRequest({
        secret: SECRET,
        body: BODY,
        timestamp: NOW,
        nonce: NONCE,
      }),
    );

    await expect(
      verifyLocalAgentRequest({
        secret: SECRET,
        headers,
        body: BODY,
        method: "POST",
        path: "/execute",
        now: NOW,
        replayCache: new NonceReplayCache(),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects nonce replay after a valid request", async () => {
    const replayCache = new NonceReplayCache();
    const headers = new Headers(
      await signLocalAgentRequest({
        secret: SECRET,
        body: BODY,
        timestamp: NOW,
        nonce: NONCE,
      }),
    );
    const input = {
      secret: SECRET,
      headers,
      body: BODY,
      method: "POST",
      path: "/execute",
      now: NOW,
      replayCache,
    };

    await expect(verifyLocalAgentRequest(input)).resolves.toEqual({ ok: true });
    await expect(verifyLocalAgentRequest(input)).resolves.toEqual({
      ok: false,
      reason: "replayed_nonce",
    });
  });

  it("binds the signature to body, method, and path", async () => {
    const headers = new Headers(
      await signLocalAgentRequest({
        secret: SECRET,
        body: BODY,
        timestamp: NOW,
        nonce: NONCE,
      }),
    );
    const replayCache = new NonceReplayCache();

    for (const input of [
      {
        body: new TextEncoder().encode('{"action":"get_order"}'),
        method: "POST",
        path: "/execute",
      },
      { body: BODY, method: "GET", path: "/execute" },
      { body: BODY, method: "POST", path: "/other" },
    ]) {
      await expect(
        verifyLocalAgentRequest({
          secret: SECRET,
          headers,
          now: NOW,
          replayCache,
          ...input,
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid_signature" });
    }
  });

  it("rejects stale, future, malformed, or incomplete headers", async () => {
    const signed = await signLocalAgentRequest({
      secret: SECRET,
      body: BODY,
      timestamp: NOW,
      nonce: NONCE,
    });
    const base = {
      secret: SECRET,
      body: BODY,
      method: "POST",
      path: "/execute",
      replayCache: new NonceReplayCache(),
    };

    await expect(
      verifyLocalAgentRequest({
        ...base,
        headers: new Headers(signed),
        now: NOW + 60_001,
      }),
    ).resolves.toEqual({ ok: false, reason: "expired_timestamp" });

    const malformed = new Headers(signed);
    malformed.set("x-amazon-agent-timestamp", "tomorrow");
    await expect(
      verifyLocalAgentRequest({ ...base, headers: malformed, now: NOW }),
    ).resolves.toEqual({ ok: false, reason: "invalid_timestamp" });

    const incomplete = new Headers(signed);
    incomplete.delete("x-amazon-agent-signature");
    await expect(
      verifyLocalAgentRequest({ ...base, headers: incomplete, now: NOW }),
    ).resolves.toEqual({ ok: false, reason: "missing_header" });
  });

  it("requires a high-entropy-length shared secret and a bounded nonce", async () => {
    expect(() => assertSecret("short")).toThrow();
    expect(() => assertSecret(SECRET)).not.toThrow();
    await expect(
      signLocalAgentRequest({
        secret: SECRET,
        body: BODY,
        timestamp: NOW,
        nonce: "tiny",
      }),
    ).rejects.toThrow();
  });

  it("fails closed instead of evicting a live nonce when the cache is full", () => {
    const cache = new NonceReplayCache(100, 1);
    expect(cache.remember("nonce_1234567890abcdef", NOW)).toBe(true);
    expect(cache.remember("nonce_abcdef1234567890", NOW + 1)).toBe(false);
    expect(cache.remember("nonce_1234567890abcdef", NOW + 2)).toBe(false);
    expect(cache.remember("nonce_abcdef1234567890", NOW + 101)).toBe(true);
  });
});
