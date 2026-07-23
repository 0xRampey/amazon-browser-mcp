import { z } from "zod";

import type { Env } from "../../env";
import type { AmazonOperationRequest } from "../../mcp/gateway";

const dateSchema = z.iso.date();
const orderIdSchema = z.string().regex(/^\d{3}-\d{7}-\d{7}$/);
const moneySchema = z.string().regex(/^(0|[1-9]\d{0,7})\.\d{2}$/);
const statusSchema = z.enum([
  "pending",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "returned",
  "refunded",
  "unknown",
]);
const maxPagesSchema = z.number().int().min(1).max(5);

const sessionStatusOperationSchema = z
  .object({ action: z.literal("session_status") })
  .strict();

const listOrdersOperationSchema = z
  .object({
    action: z.literal("list_orders"),
    orderedFrom: dateSchema.optional(),
    orderedTo: dateSchema.optional(),
    statuses: z.array(statusSchema).max(8).optional(),
    limit: z.number().int().min(1).max(50),
    maxPages: maxPagesSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.orderedFrom !== undefined &&
      input.orderedTo !== undefined &&
      input.orderedFrom > input.orderedTo
    ) {
      context.addIssue({
        code: "custom",
        message: "orderedFrom must not be after orderedTo",
        path: ["orderedFrom"],
      });
    }

    if (input.statuses && new Set(input.statuses).size !== input.statuses.length) {
      context.addIssue({
        code: "custom",
        message: "statuses must not contain duplicates",
        path: ["statuses"],
      });
    }
  });

const getOrderOperationSchema = z
  .object({
    action: z.literal("get_order"),
    orderId: orderIdSchema,
  })
  .strict();

const findOrdersOperationSchema = z
  .object({
    action: z.literal("find_orders"),
    orderId: orderIdSchema.optional(),
    amount: moneySchema.optional(),
    currency: z.literal("USD"),
    orderedOn: dateSchema.optional(),
    dateWindowDays: z.number().int().min(0).max(30),
    amountTolerance: moneySchema,
    itemQuery: z.string().trim().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(20),
    maxPages: maxPagesSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.orderId && !input.amount && !input.orderedOn && !input.itemQuery) {
      context.addIssue({
        code: "custom",
        message: "At least one search criterion is required",
      });
    }

    if (!input.amount && input.amountTolerance !== "0.00") {
      context.addIssue({
        code: "custom",
        message: "amountTolerance requires amount",
        path: ["amountTolerance"],
      });
    }
  });

/**
 * The only operations accepted at the Durable Object boundary. This repeats
 * validation done by MCP intentionally: Durable Object requests are treated as
 * untrusted even though the namespace is reachable only through the Worker.
 */
export const amazonInternalOperationSchema: z.ZodType<AmazonOperationRequest> =
  z.discriminatedUnion("action", [
    sessionStatusOperationSchema,
    listOrdersOperationSchema,
    getOrderOperationSchema,
    findOrdersOperationSchema,
  ]);

export type AmazonInternalOperation = z.infer<typeof amazonInternalOperationSchema>;

export type AmazonOperationExecutor = (
  env: Env,
  request: AmazonInternalOperation,
) => Promise<Record<string, unknown>>;

export interface AmazonInternalSuccess {
  ok: true;
  data: Record<string, unknown>;
}

export interface AmazonInternalFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    userActionRequired?: boolean;
  };
}

export type AmazonInternalResult = AmazonInternalSuccess | AmazonInternalFailure;

export const AMAZON_OPERATION_ERROR_CODES = [
  "LOGIN_REQUIRED",
  "CHALLENGE_REQUIRED",
  "NOT_FOUND",
  "PARSER_DRIFT",
  "POLICY_BLOCKED",
  "BROWSER_QUOTA_EXHAUSTED",
  "LOCAL_AGENT_UNAVAILABLE",
  "RATE_LIMITED",
  "QUEUE_FULL",
  "TEMPORARY_FAILURE",
] as const;

export type AmazonOperationErrorCode =
  (typeof AMAZON_OPERATION_ERROR_CODES)[number];

const SAFE_ERROR_DETAILS: Record<
  AmazonOperationErrorCode,
  { message: string; userActionRequired: boolean }
> = {
  LOGIN_REQUIRED: {
    message: "Amazon sign-in is required.",
    userActionRequired: true,
  },
  CHALLENGE_REQUIRED: {
    message: "Amazon requires an interactive verification step.",
    userActionRequired: true,
  },
  NOT_FOUND: {
    message: "The requested Amazon order was not found.",
    userActionRequired: false,
  },
  PARSER_DRIFT: {
    message: "Amazon's order page could not be read safely.",
    userActionRequired: false,
  },
  POLICY_BLOCKED: {
    message: "The browser request was blocked by the read-only policy.",
    userActionRequired: false,
  },
  BROWSER_QUOTA_EXHAUSTED: {
    message: "Browserbase browser-minute quota is exhausted.",
    userActionRequired: true,
  },
  LOCAL_AGENT_UNAVAILABLE: {
    message: "The local Amazon browser agent is unavailable. Start the Mac agent and try again.",
    userActionRequired: true,
  },
  RATE_LIMITED: {
    message: "Amazon temporarily limited this request.",
    userActionRequired: false,
  },
  QUEUE_FULL: {
    message: "Too many Amazon operations are pending.",
    userActionRequired: false,
  },
  TEMPORARY_FAILURE: {
    message: "The Amazon browser service is temporarily unavailable.",
    userActionRequired: false,
  },
};

/**
 * The only service exception whose fields may cross the Durable Object
 * boundary. Messages are selected by code instead of supplied by callers, so
 * upstream diagnostics cannot accidentally become public output.
 */
export class AmazonOperationError extends Error {
  readonly code: AmazonOperationErrorCode;
  readonly userActionRequired: boolean;

  constructor(code: AmazonOperationErrorCode) {
    const details = SAFE_ERROR_DETAILS[code];
    super(details.message);
    this.name = "AmazonOperationError";
    this.code = code;
    this.userActionRequired = details.userActionRequired;
  }
}

export function isAmazonOperationErrorCode(
  value: unknown,
): value is AmazonOperationErrorCode {
  return (
    typeof value === "string" &&
    (AMAZON_OPERATION_ERROR_CODES as readonly string[]).includes(value)
  );
}
