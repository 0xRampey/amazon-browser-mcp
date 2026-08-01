import { QueueFullError, SerialQueue } from "../../browser/serial-queue";
import { resolveAmazonBrowserBackend } from "../../browser/amazon-backend";
import { executeLocalAmazonOperation } from "../../browser/local-agent-executor";
import type { Env } from "../../env";
import { executeAmazonOperation } from "./service";
import {
  AmazonOperationError,
  amazonInternalOperationSchema,
  type AmazonInternalFailure,
  type AmazonInternalResult,
  type AmazonOperationExecutor,
} from "./operations";

export const AMAZON_OPERATION_PATH = "/execute";
export const MAX_OPERATION_BODY_BYTES = 16 * 1024;
export const MAX_OPERATION_QUEUE_DEPTH = 8;

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

/**
 * Serializes access to the configured Amazon browser runtime.
 *
 * Every caller must use the same named Durable Object id (the gateway uses
 * `amazon-primary`) and POST JSON to `/execute`. Do not wrap slow browser work
 * in `blockConcurrencyWhile`; this instance queue intentionally allows new
 * requests to enter, be bounded, and wait in FIFO order.
 *
 * The selected executor must return only schema-validated, privacy-filtered
 * data. Raw HTML, cookies, connection URLs, headers, and upstream error text
 * must never cross that function boundary.
 */
export class AmazonBrowser implements DurableObject {
  private readonly queue = new SerialQueue(MAX_OPERATION_QUEUE_DEPTH);
  private readonly execute: AmazonOperationExecutor;

  constructor(
    _state: DurableObjectState,
    private readonly env: Env,
    execute?: AmazonOperationExecutor,
  ) {
    // Cloudflare supplies two constructor arguments. The optional executor is a
    // narrow test seam. Production defaults to the local VPC-backed runtime;
    // Browserbase remains an explicit fallback.
    this.execute = execute ?? executorForEnvironment(env);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname !== AMAZON_OPERATION_PATH) {
        return errorResponse(404, "NOT_FOUND", "Internal operation endpoint not found.");
      }

      if (request.method !== "POST") {
        return errorResponse(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.", {
          Allow: "POST",
        });
      }

      const contentType = request.headers.get("Content-Type") ?? "";
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        return errorResponse(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Content-Type must be application/json.",
        );
      }

      const body = await readBoundedJson(request, MAX_OPERATION_BODY_BYTES);
      if (!body.ok) {
        return errorResponse(body.status, body.code, body.message);
      }

      const parsed = amazonInternalOperationSchema.safeParse(body.value);
      if (!parsed.success) {
        return errorResponse(400, "INVALID_OPERATION", "The operation payload is invalid.");
      }

      try {
        const data = await this.queue.run(() => this.execute(this.env, parsed.data));
        return resultResponse({ ok: true, data });
      } catch (error: unknown) {
        if (error instanceof QueueFullError) {
          return errorResponse(429, "QUEUE_FULL", "Too many Amazon operations are pending.", {
            "Retry-After": "1",
          });
        }

        if (error instanceof AmazonOperationError) {
          return operationErrorResponse(error);
        }

        // Browser/service exceptions can contain URLs, identifiers, page data,
        // or vendor diagnostics. Do not branch on or serialize their messages.
        return errorResponse(
          503,
          "TEMPORARY_FAILURE",
          "The Amazon browser service is temporarily unavailable.",
        );
      }
    } catch (_error: unknown) {
      // Also catches invalid service return values during JSON serialization.
      // Never allow a runtime-generated HTML error or raw exception to escape.
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The internal browser operation could not be completed.",
      );
    }
  }
}

export function executorForEnvironment(env: Env): AmazonOperationExecutor {
  switch (resolveAmazonBrowserBackend(env.AMAZON_BROWSER_BACKEND)) {
    case "local":
      return executeLocalAmazonOperation;
    case "browserbase":
      return executeAmazonOperation;
    default:
      return async () => {
        throw new AmazonOperationError("TEMPORARY_FAILURE");
      };
  }
}

function operationErrorResponse(error: AmazonOperationError): Response {
  const result: AmazonInternalFailure = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      userActionRequired: error.userActionRequired,
    },
  };

  return resultResponse(result);
}

function resultResponse(result: AmazonInternalResult): Response {
  return jsonResponse(result, result.ok ? 200 : statusForFailure(result));
}

function statusForFailure(result: AmazonInternalFailure): number {
  switch (result.error.code) {
    case "NOT_FOUND":
      return 404;
    case "POLICY_BLOCKED":
      return 403;
    case "BROWSER_QUOTA_EXHAUSTED":
      return 402;
    case "LOGIN_REQUIRED":
    case "CHALLENGE_REQUIRED":
      return 409;
    case "RATE_LIMITED":
    case "QUEUE_FULL":
      return 429;
    case "INVALID_INPUT":
    case "INVALID_OPERATION":
      return 400;
    default:
      return 503;
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return jsonResponse(
    {
      ok: false,
      error: {
        code,
        message,
      },
    },
    status,
    extraHeaders,
  );
}

function jsonResponse(
  value: AmazonInternalResult,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders,
    },
  });
}

type BodyReadResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      status: number;
      code: "BODY_TOO_LARGE" | "INVALID_JSON";
      message: string;
    };

async function readBoundedJson(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) > maxBytes) {
      return {
        ok: false,
        status: 413,
        code: "BODY_TOO_LARGE",
        message: "The operation payload is too large.",
      };
    }
  }

  if (!request.body) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_JSON",
      message: "A JSON operation payload is required.",
    };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size decision is already final. A transport cancellation error
          // must not change it or disclose a lower-level stream diagnostic.
        }
        return {
          ok: false,
          status: 413,
          code: "BODY_TOO_LARGE",
          message: "The operation payload is too large.",
        };
      }
      chunks.push(value);
    }
  } catch (_error: unknown) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_JSON",
      message: "The operation payload could not be read.",
    };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (_error: unknown) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_JSON",
      message: "The operation payload must be valid JSON.",
    };
  }
}
