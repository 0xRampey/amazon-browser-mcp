import { z } from "zod";

import { signLocalAgentRequest } from "../../scripts/local-browser-agent/auth";
import type { Env } from "../env";
import { parseAmazonOperationOutput } from "../mcp/output";
import {
  AmazonOperationError,
  isAmazonOperationErrorCode,
  type AmazonInternalOperation,
} from "../sites/amazon/operations";

export const LOCAL_AGENT_OPERATION_URL =
  "http://amazon-browser-agent.internal/execute";
export const MAX_LOCAL_AGENT_RESPONSE_BYTES = 2 * 1024 * 1024;

const responseEnvelopeSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      data: z.unknown(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().min(1).max(64),
          message: z.string().max(500),
          userActionRequired: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
]);

/**
 * Executes one already-validated Amazon operation through the private VPC
 * Service binding. The signature covers the exact UTF-8 JSON body sent to the
 * local agent. Neither raw upstream responses nor upstream error messages cross
 * this boundary.
 */
export async function executeLocalAmazonOperation(
  env: Env,
  operation: AmazonInternalOperation,
): Promise<Record<string, unknown>> {
  const bodyText = JSON.stringify(operation);
  const bodyBytes = new TextEncoder().encode(bodyText);

  let response: Response;
  try {
    const authentication = await signLocalAgentRequest({
      secret: env.LOCAL_BROWSER_AGENT_SECRET,
      body: bodyBytes,
      method: "POST",
      path: "/execute",
    });
    response = await env.LOCAL_BROWSER_AGENT.fetch(LOCAL_AGENT_OPERATION_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        ...authentication,
      },
      body: bodyText,
    });
  } catch {
    throw new AmazonOperationError("LOCAL_AGENT_UNAVAILABLE");
  }

  const envelope = await readLocalAgentEnvelope(response);
  if (!envelope) {
    throw new AmazonOperationError("TEMPORARY_FAILURE");
  }

  if (!envelope.ok) {
    if (isAmazonOperationErrorCode(envelope.error.code)) {
      throw new AmazonOperationError(envelope.error.code);
    }
    throw new AmazonOperationError("TEMPORARY_FAILURE");
  }

  if (!response.ok) {
    throw new AmazonOperationError("TEMPORARY_FAILURE");
  }

  const output = parseAmazonOperationOutput(operation, envelope.data);
  if (!output) {
    throw new AmazonOperationError("TEMPORARY_FAILURE");
  }
  return output;
}

async function readLocalAgentEnvelope(
  response: Response,
): Promise<z.infer<typeof responseEnvelopeSchema> | undefined> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return undefined;

  const bytes = await readBoundedResponse(response, MAX_LOCAL_AGENT_RESPONSE_BYTES);
  if (!bytes) return undefined;

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = responseEnvelopeSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) > maxBytes) {
      return undefined;
    }
  }
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
