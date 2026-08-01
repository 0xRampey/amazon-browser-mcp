import {
  QueueFullError,
  SerialQueue,
} from "../../src/browser/serial-queue";
import { parseAmazonOperationOutput, safeGatewayError } from "../../src/mcp/output";
import {
  AmazonOperationError,
  amazonInternalOperationSchema,
  type AmazonInternalFailure,
  type AmazonInternalOperation,
  type AmazonInternalResult,
} from "../../src/sites/amazon/operations";
import {
  NonceReplayCache,
  verifyLocalAgentRequest,
} from "./auth";

export const LOCAL_AGENT_OPERATION_PATH = "/execute";
export const LOCAL_AGENT_MAX_BODY_BYTES = 16 * 1024;
export const LOCAL_AGENT_MAX_QUEUE_DEPTH = 8;

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export type LocalOperationExecutor = (
  request: AmazonInternalOperation,
) => Promise<Record<string, unknown>>;

export function createLocalAgentHandler(input: {
  secret: string;
  execute: LocalOperationExecutor;
  now?: () => number;
  replayCache?: NonceReplayCache;
  queue?: SerialQueue;
}): (request: Request) => Promise<Response> {
  const replayCache = input.replayCache ?? new NonceReplayCache();
  const queue = input.queue ?? new SerialQueue(LOCAL_AGENT_MAX_QUEUE_DEPTH);

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.pathname !== LOCAL_AGENT_OPERATION_PATH || url.search !== "") {
        return errorResponse(404, "NOT_FOUND", "Local operation endpoint not found.");
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

      const body = await readBoundedBody(request, LOCAL_AGENT_MAX_BODY_BYTES);
      if (!body.ok) {
        return errorResponse(body.status, body.code, body.message);
      }

      const authentication = await verifyLocalAgentRequest({
        secret: input.secret,
        headers: request.headers,
        body: body.bytes,
        method: request.method,
        path: url.pathname,
        now: input.now?.(),
        replayCache,
      });
      if (!authentication.ok) {
        return errorResponse(401, "UNAUTHORIZED", "Request authentication failed.");
      }

      let payload: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
        payload = JSON.parse(text) as unknown;
      } catch {
        return errorResponse(400, "INVALID_JSON", "The operation payload must be valid JSON.");
      }

      const parsed = amazonInternalOperationSchema.safeParse(payload);
      if (!parsed.success) {
        return errorResponse(
          400,
          "INVALID_OPERATION",
          "The operation payload is invalid.",
        );
      }

      try {
        const rawData = await queue.run(() => input.execute(parsed.data));
        const data = parseAmazonOperationOutput(parsed.data, rawData);
        if (!data) {
          return errorResponse(
            503,
            "TEMPORARY_FAILURE",
            "The Amazon browser service is temporarily unavailable.",
          );
        }
        return resultResponse({ ok: true, data });
      } catch (error: unknown) {
        if (error instanceof QueueFullError) {
          return errorResponse(
            429,
            "QUEUE_FULL",
            "Too many Amazon operations are pending.",
            { "Retry-After": "1" },
          );
        }
        if (error instanceof AmazonOperationError) {
          const safe = safeGatewayError(error.code);
          return resultResponse({
            ok: false,
            error: {
              code: safe.code,
              message: safe.message,
              userActionRequired: safe.userActionRequired,
            },
          });
        }
        return errorResponse(
          503,
          "TEMPORARY_FAILURE",
          "The Amazon browser service is temporarily unavailable.",
        );
      }
    } catch {
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The local browser operation could not be completed.",
      );
    }
  };
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
      error: { code, message },
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
  | { ok: true; bytes: Uint8Array }
  | {
      ok: false;
      status: number;
      code: "BODY_TOO_LARGE" | "INVALID_JSON";
      message: string;
    };

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<BodyReadResult> {
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
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          status: 413,
          code: "BODY_TOO_LARGE",
          message: "The operation payload is too large.",
        };
      }
      chunks.push(value);
    }
  } catch {
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
  return { ok: true, bytes };
}
