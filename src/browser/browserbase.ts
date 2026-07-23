const BROWSERBASE_SESSIONS_ENDPOINT = "https://api.browserbase.com/v1/sessions";

export const BROWSERBASE_REGIONS = [
  "us-west-2",
  "us-east-1",
  "eu-central-1",
  "ap-southeast-1",
] as const;

export type BrowserbaseRegion = (typeof BROWSERBASE_REGIONS)[number];

export const MIN_BROWSER_SESSION_TIMEOUT_SECONDS = 60;
export const MAX_BROWSER_SESSION_TIMEOUT_SECONDS = 300;
export const DEFAULT_BROWSER_SESSION_TIMEOUT_SECONDS = 180;

const API_REQUEST_TIMEOUT_MS = 15_000;
const SESSION_METADATA = Object.freeze({ integration: "amazon-orders-read" });

export interface CreateBrowserbaseSessionInput {
  apiKey: string;
  contextId: string;
  region: BrowserbaseRegion;
  timeoutSeconds?: number;
}

export interface ReleaseBrowserbaseSessionInput {
  apiKey: string;
  sessionId: string;
}

/**
 * The connection URL is a bearer credential. Keep this object inside the
 * browser runtime and never serialize it into an MCP response or log entry.
 */
export interface BrowserbaseSessionConnection {
  id: string;
  connectUrl: string;
  expiresAt?: string;
}

export type BrowserbaseSessionErrorCode =
  | "invalid_configuration"
  | "authentication_failed"
  | "quota_exhausted"
  | "rate_limited"
  | "upstream_rejected"
  | "upstream_unavailable"
  | "request_timed_out"
  | "invalid_response";

export class BrowserbaseSessionError extends Error {
  readonly code: BrowserbaseSessionErrorCode;

  constructor(code: BrowserbaseSessionErrorCode, message: string) {
    super(message);
    this.name = "BrowserbaseSessionError";
    this.code = code;
  }
}

export interface BrowserbaseSessionDependencies {
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

interface BrowserbaseCreateSessionResponse {
  id?: unknown;
  connectUrl?: unknown;
  expiresAt?: unknown;
}

/**
 * Create an ephemeral, read-only Browserbase session from an existing Context.
 *
 * Deliberately uses the REST API rather than an SDK so the exact privacy and
 * persistence controls sent in production remain auditable. Browserbase infers
 * the project from the API key; a project ID is intentionally never accepted.
 */
export async function createBrowserbaseSession(
  input: CreateBrowserbaseSessionInput,
  dependencies: BrowserbaseSessionDependencies = {},
): Promise<BrowserbaseSessionConnection> {
  validateConfiguration(input);

  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new BrowserbaseSessionError(
      "invalid_configuration",
      "Browser session transport is unavailable.",
    );
  }

  const requestTimeoutMs = normalizeRequestTimeout(dependencies.requestTimeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  let response: Response;
  try {
    response = await fetchImplementation(BROWSERBASE_SESSIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bb-api-key": input.apiKey,
      },
      body: JSON.stringify(buildCreateSessionBody(input)),
      // Manual mode does not forward the API key to a redirect target and is
      // compatible with Workers' handling of Browserbase's authenticated edge.
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new BrowserbaseSessionError(
        "request_timed_out",
        "Browser session creation timed out.",
      );
    }

    // Do not propagate a fetch error's message or cause. Runtime errors can
    // contain request details, and the connection/context values are secrets.
    throw new BrowserbaseSessionError(
      "upstream_unavailable",
      "Browser session service is unavailable.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw createStatusError(response.status);
  }

  let payload: BrowserbaseCreateSessionResponse;
  try {
    payload = (await response.json()) as BrowserbaseCreateSessionResponse;
  } catch {
    throw invalidResponseError();
  }

  if (!isNonEmptyBoundedString(payload.id, 256)) {
    throw invalidResponseError();
  }
  if (!isTrustedBrowserbaseConnectUrl(payload.connectUrl)) {
    throw invalidResponseError();
  }
  if (
    payload.expiresAt !== undefined &&
    (!isNonEmptyBoundedString(payload.expiresAt, 128) ||
      Number.isNaN(Date.parse(payload.expiresAt)))
  ) {
    throw invalidResponseError();
  }

  return {
    id: payload.id,
    connectUrl: payload.connectUrl,
    ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
  };
}

/**
 * Request prompt release even if browser shutdown or a parser operation fails.
 * The session was created with keepAlive=false, but the explicit lifecycle
 * update avoids leaving a persistent Context locked until its timeout.
 */
export async function releaseBrowserbaseSession(
  input: ReleaseBrowserbaseSessionInput,
  dependencies: BrowserbaseSessionDependencies = {},
): Promise<void> {
  if (!isNonEmptyBoundedString(input.apiKey, 1_024) || !isOpaqueIdentifier(input.sessionId)) {
    throw new BrowserbaseSessionError(
      "invalid_configuration",
      "Browser session release is not configured.",
    );
  }

  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new BrowserbaseSessionError(
      "invalid_configuration",
      "Browser session transport is unavailable.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    normalizeRequestTimeout(dependencies.requestTimeoutMs),
  );

  let response: Response;
  try {
    response = await fetchImplementation(
      `${BROWSERBASE_SESSIONS_ENDPOINT}/${encodeURIComponent(input.sessionId)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bb-api-key": input.apiKey,
        },
        body: JSON.stringify({ status: "REQUEST_RELEASE" }),
        redirect: "manual",
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new BrowserbaseSessionError(
        "request_timed_out",
        "Browser session release timed out.",
      );
    }
    throw new BrowserbaseSessionError(
      "upstream_unavailable",
      "Browser session service is unavailable.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw createStatusError(response.status);
  }
}

export function buildCreateSessionBody(input: CreateBrowserbaseSessionInput): {
  browserSettings: {
    context: { id: string; persist: false };
    recordSession: false;
    logSession: false;
    solveCaptchas: false;
  };
  timeout: number;
  keepAlive: false;
  region: BrowserbaseRegion;
  userMetadata: typeof SESSION_METADATA;
} {
  validateConfiguration(input);

  return {
    browserSettings: {
      context: {
        id: input.contextId,
        persist: false,
      },
      recordSession: false,
      logSession: false,
      solveCaptchas: false,
    },
    timeout: normalizeSessionTimeout(input.timeoutSeconds),
    keepAlive: false,
    region: input.region,
    userMetadata: SESSION_METADATA,
  };
}

export function normalizeSessionTimeout(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined) {
    return DEFAULT_BROWSER_SESSION_TIMEOUT_SECONDS;
  }
  if (!Number.isSafeInteger(timeoutSeconds)) {
    throw new BrowserbaseSessionError(
      "invalid_configuration",
      "Browser session timeout must be an integer number of seconds.",
    );
  }

  // Clamping keeps sessions bounded even if an internal caller forwards a
  // stale or overly permissive setting. Browserbase itself requires >= 60s.
  return Math.min(
    MAX_BROWSER_SESSION_TIMEOUT_SECONDS,
    Math.max(MIN_BROWSER_SESSION_TIMEOUT_SECONDS, timeoutSeconds),
  );
}

function validateConfiguration(input: CreateBrowserbaseSessionInput): void {
  if (!isNonEmptyBoundedString(input.apiKey, 1_024)) {
    throw new BrowserbaseSessionError(
      "invalid_configuration",
      "Browserbase API credentials are not configured.",
    );
  }
  if (!isOpaqueIdentifier(input.contextId)) {
    throw new BrowserbaseSessionError(
      "invalid_configuration",
      "Browser context is not configured.",
    );
  }
  if (!BROWSERBASE_REGIONS.includes(input.region)) {
    throw new BrowserbaseSessionError(
      "invalid_configuration",
      "Browser region is not supported.",
    );
  }
  normalizeSessionTimeout(input.timeoutSeconds);
}

function normalizeRequestTimeout(value?: number): number {
  if (value === undefined) {
    return API_REQUEST_TIMEOUT_MS;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new BrowserbaseSessionError(
      "invalid_configuration",
      "Browser session request timeout is invalid.",
    );
  }
  return value;
}

function isOpaqueIdentifier(value: unknown): value is string {
  return (
    isNonEmptyBoundedString(value, 256) &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f\s]/u.test(value)
  );
}

function isNonEmptyBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function isTrustedBrowserbaseConnectUrl(value: unknown): value is string {
  if (!isNonEmptyBoundedString(value, 8_192)) {
    return false;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "wss:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      (host === "browserbase.com" || host.endsWith(".browserbase.com"))
    );
  } catch {
    return false;
  }
}

function createStatusError(status: number): BrowserbaseSessionError {
  if (status === 401 || status === 403) {
    return new BrowserbaseSessionError(
      "authentication_failed",
      "Browser session service rejected its credentials.",
    );
  }
  if (status === 402) {
    return new BrowserbaseSessionError(
      "quota_exhausted",
      "Browser session service quota is exhausted.",
    );
  }
  if (status === 429) {
    return new BrowserbaseSessionError(
      "rate_limited",
      "Browser session capacity is temporarily unavailable.",
    );
  }
  if (status >= 500) {
    return new BrowserbaseSessionError(
      "upstream_unavailable",
      "Browser session service is unavailable.",
    );
  }
  return new BrowserbaseSessionError(
    "upstream_rejected",
    "Browser session service rejected the request.",
  );
}

function invalidResponseError(): BrowserbaseSessionError {
  return new BrowserbaseSessionError(
    "invalid_response",
    "Browser session service returned an invalid response.",
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
