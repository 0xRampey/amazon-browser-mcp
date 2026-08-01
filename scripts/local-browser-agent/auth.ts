const AUTH_VERSION = "amazon-local-agent-v1";
const DEFAULT_MAX_CLOCK_SKEW_MS = 60_000;
const MAX_SECRET_BYTES = 1_024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{13}$/;

export const LOCAL_AGENT_AUTH_HEADERS = {
  timestamp: "x-amazon-agent-timestamp",
  nonce: "x-amazon-agent-nonce",
  signature: "x-amazon-agent-signature",
} as const;

export interface LocalAgentSignatureInput {
  secret: string;
  body: Uint8Array;
  method?: string;
  path?: string;
  timestamp?: number;
  nonce?: string;
}

export type LocalAgentAuthHeaders = Record<
  | "x-amazon-agent-timestamp"
  | "x-amazon-agent-nonce"
  | "x-amazon-agent-signature",
  string
>;

export type LocalAgentAuthFailure =
  | "invalid_secret"
  | "missing_header"
  | "invalid_timestamp"
  | "expired_timestamp"
  | "invalid_nonce"
  | "invalid_signature"
  | "replayed_nonce";

export type LocalAgentAuthResult =
  | { ok: true }
  | { ok: false; reason: LocalAgentAuthFailure };

export class NonceReplayCache {
  private readonly expirations = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_MAX_CLOCK_SKEW_MS * 2,
    private readonly maxEntries = 2_048,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new TypeError("Nonce cache TTL must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("Nonce cache size must be a positive integer.");
    }
  }

  remember(nonce: string, now: number): boolean {
    this.prune(now);
    const existing = this.expirations.get(nonce);
    if (existing !== undefined && existing > now) return false;
    // Never evict a still-valid nonce: doing so would make that request
    // replayable during the accepted timestamp window. Saturation fails closed.
    if (this.expirations.size >= this.maxEntries) return false;
    this.expirations.set(nonce, now + this.ttlMs);
    return true;
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.expirations) {
      if (expiresAt > now) continue;
      this.expirations.delete(nonce);
    }
  }
}

export async function signLocalAgentRequest(
  input: LocalAgentSignatureInput,
): Promise<LocalAgentAuthHeaders> {
  assertSecret(input.secret);
  const timestamp = input.timestamp ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 1_000_000_000_000) {
    throw new TypeError("The signature timestamp must be Unix milliseconds.");
  }
  const nonce = input.nonce ?? crypto.randomUUID().replaceAll("-", "");
  if (!NONCE_PATTERN.test(nonce)) {
    throw new TypeError("The signature nonce has an invalid format.");
  }

  const canonical = await canonicalRequest(
    input.method ?? "POST",
    input.path ?? "/execute",
    timestamp,
    nonce,
    input.body,
  );
  const key = await importHmacKey(input.secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );

  return {
    [LOCAL_AGENT_AUTH_HEADERS.timestamp]: String(timestamp),
    [LOCAL_AGENT_AUTH_HEADERS.nonce]: nonce,
    [LOCAL_AGENT_AUTH_HEADERS.signature]: bytesToHex(new Uint8Array(signature)),
  };
}

export async function verifyLocalAgentRequest(
  input: {
    secret: string;
    headers: Headers;
    body: Uint8Array;
    method: string;
    path: string;
    now?: number;
    maxClockSkewMs?: number;
    replayCache: NonceReplayCache;
  },
): Promise<LocalAgentAuthResult> {
  try {
    assertSecret(input.secret);
  } catch {
    return { ok: false, reason: "invalid_secret" };
  }

  const timestampValue = input.headers.get(LOCAL_AGENT_AUTH_HEADERS.timestamp);
  const nonce = input.headers.get(LOCAL_AGENT_AUTH_HEADERS.nonce);
  const signatureValue = input.headers.get(LOCAL_AGENT_AUTH_HEADERS.signature);
  if (timestampValue === null || nonce === null || signatureValue === null) {
    return { ok: false, reason: "missing_header" };
  }
  if (!TIMESTAMP_PATTERN.test(timestampValue)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const now = input.now ?? Date.now();
  const maxClockSkewMs = input.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  if (
    !Number.isSafeInteger(maxClockSkewMs) ||
    maxClockSkewMs < 1 ||
    Math.abs(now - timestamp) > maxClockSkewMs
  ) {
    return { ok: false, reason: "expired_timestamp" };
  }
  if (!NONCE_PATTERN.test(nonce)) {
    return { ok: false, reason: "invalid_nonce" };
  }
  if (!SIGNATURE_PATTERN.test(signatureValue)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const canonical = await canonicalRequest(
    input.method,
    input.path,
    timestamp,
    nonce,
    input.body,
  );
  const key = await importHmacKey(input.secret, ["verify"]);
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    exactArrayBuffer(hexToBytes(signatureValue)),
    new TextEncoder().encode(canonical),
  );
  if (!verified) return { ok: false, reason: "invalid_signature" };
  if (!input.replayCache.remember(nonce, now)) {
    return { ok: false, reason: "replayed_nonce" };
  }
  return { ok: true };
}

export function assertSecret(secret: string): void {
  const byteLength = new TextEncoder().encode(secret).byteLength;
  if (byteLength < 32 || byteLength > MAX_SECRET_BYTES) {
    throw new TypeError("The local agent secret must contain 32 to 1024 UTF-8 bytes.");
  }
}

async function canonicalRequest(
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  body: Uint8Array,
): Promise<string> {
  const bodyDigest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(body));
  return [
    AUTH_VERSION,
    String(timestamp),
    nonce,
    method.toUpperCase(),
    path,
    bytesToHex(new Uint8Array(bodyDigest)),
  ].join("\n");
}

async function importHmacKey(
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function hexToBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
