import type { Env } from "../env";
import { parseAmazonOperationOutput, safeGatewayError } from "./output";

export type AmazonOperationRequest =
  | { action: "session_status" }
  | {
      action: "list_orders";
      orderedFrom?: string;
      orderedTo?: string;
      statuses?: string[];
      limit: number;
      maxPages: number;
    }
  | { action: "get_order"; orderId: string }
  | {
      action: "find_orders";
      orderId?: string;
      amount?: string;
      currency: "USD";
      orderedOn?: string;
      dateWindowDays: number;
      amountTolerance: string;
      itemQuery?: string;
      limit: number;
      maxPages: number;
    };

export interface AmazonGateway {
  execute(request: AmazonOperationRequest): Promise<Record<string, unknown>>;
}

export class AmazonGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly userActionRequired = false,
  ) {
    super(message);
    this.name = "AmazonGatewayError";
  }
}

export class DurableObjectAmazonGateway implements AmazonGateway {
  constructor(private readonly env: Env) {}

  async execute(request: AmazonOperationRequest): Promise<Record<string, unknown>> {
    const id = this.env.AMAZON_BROWSER.idFromName("amazon-primary");
    const stub = this.env.AMAZON_BROWSER.get(id);
    const response = await stub.fetch("https://amazon-browser.internal/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new AmazonGatewayError("TEMPORARY_FAILURE", "The Amazon browser returned an invalid response.");
    }

    if (!response.ok || !isInternalSuccess(result)) {
      const error = safeGatewayError(isInternalFailure(result) ? result.error.code : undefined);
      throw new AmazonGatewayError(
        error.code,
        error.message,
        error.userActionRequired,
      );
    }

    const data = parseAmazonOperationOutput(request, result.data);
    if (!data) {
      throw new AmazonGatewayError(
        "TEMPORARY_FAILURE",
        "The Amazon browser returned an invalid response.",
      );
    }
    return data;
  }
}

function isInternalSuccess(value: unknown): value is { ok: true; data: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "ok") === true &&
    Object.hasOwn(value, "data")
  );
}

function isInternalFailure(value: unknown): value is { ok: false; error: { code: unknown } } {
  if (typeof value !== "object" || value === null || Reflect.get(value, "ok") !== false) {
    return false;
  }
  const error = Reflect.get(value, "error");
  return typeof error === "object" && error !== null && Object.hasOwn(error, "code");
}
