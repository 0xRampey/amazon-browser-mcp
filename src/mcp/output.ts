import { z } from "zod";

import type { AmazonOperationRequest } from "./gateway";

const orderIdSchema = z.string().regex(/^\d{3}-\d{7}-\d{7}$/);
const dateSchema = z.iso.date();
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
const amountSchema = z
  .object({
    amount: z.string().regex(/^-?(?:0|[1-9]\d{0,8})\.\d{2}$/),
    currency: z.literal("USD"),
  })
  .strict();
const itemSchema = z
  .object({
    title: z.string().min(1).max(500),
    asin: z.string().regex(/^[A-Z0-9]{10}$/),
    quantity: z.number().int().min(1).max(999),
  })
  .strict();
const itemListSchema = z.array(itemSchema).max(500);

const orderSummarySchema = z
  .object({
    order_id: orderIdSchema,
    ordered_on: dateSchema,
    total: amountSchema,
    status: statusSchema,
    status_label: z.string().min(1).max(120),
    item_previews: itemListSchema,
  })
  .strict();

const shipmentSchema = z
  .object({
    status: statusSchema,
    status_label: z.string().min(1).max(120),
    total: amountSchema.nullable(),
    items: itemListSchema,
  })
  .strict();

const priceBreakdownSchema = z
  .object({
    item_subtotal: amountSchema.nullable(),
    shipping: amountSchema.nullable(),
    tax: amountSchema.nullable(),
    discounts: amountSchema.nullable(),
    order_total: amountSchema,
  })
  .strict();

const orderDetailSchema = z
  .object({
    order_id: orderIdSchema,
    ordered_on: dateSchema,
    total: amountSchema,
    items: itemListSchema,
    shipments: z.array(shipmentSchema).min(1).max(100),
    price_breakdown: priceBreakdownSchema.nullable(),
  })
  .strict();

const operationOutputSchemas = {
  session_status: z
    .object({
      state: z.enum([
        "authenticated",
        "login_required",
        "challenge_required",
        "unavailable",
      ]),
      profile_alias: z.literal("amazon-primary"),
      checked_at: z.iso.datetime({ offset: true }),
    })
    .strict(),
  list_orders: z
    .object({
      orders: z.array(orderSummarySchema).max(50),
      has_more: z.boolean(),
    })
    .strict(),
  get_order: z.object({ order: orderDetailSchema }).strict(),
  find_orders: z
    .object({
      status: z.enum(["none", "unique", "ambiguous"]),
      candidates: z
        .array(
          z
            .object({
              order: z.union([orderSummarySchema, orderDetailSchema]),
              score: z.number().min(0).max(1),
              matched_on: z
                .array(z.enum(["order_id", "date", "item_title", "amount"]))
                .max(4)
                .refine((values) => new Set(values).size === values.length),
              amount_source: z
                .string()
                .regex(/^(?:order_total|shipment_[1-9]\d{0,2}_total)$/)
                .nullable(),
              amount_delta: amountSchema.nullable(),
              date_delta_days: z.number().int().min(0).max(30).nullable(),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
} as const;

/**
 * The Durable Object is an internal trust boundary, not a reason to accept an
 * arbitrary JSON object. Validate the exact per-tool response shape here so a
 * future browser/parser mistake cannot send URLs, HTML, credentials, or extra
 * private fields through the MCP response.
 */
export function parseAmazonOperationOutput(
  request: AmazonOperationRequest,
  value: unknown,
): Record<string, unknown> | undefined {
  const parsed = operationOutputSchemas[request.action].safeParse(value);
  return parsed.success ? (parsed.data as Record<string, unknown>) : undefined;
}

export const SAFE_GATEWAY_ERRORS = {
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
} as const;

export type SafeGatewayErrorCode = keyof typeof SAFE_GATEWAY_ERRORS;

export function safeGatewayError(code: unknown): {
  code: SafeGatewayErrorCode;
  message: string;
  userActionRequired: boolean;
} {
  if (typeof code === "string" && Object.hasOwn(SAFE_GATEWAY_ERRORS, code)) {
    const safeCode = code as SafeGatewayErrorCode;
    return { code: safeCode, ...SAFE_GATEWAY_ERRORS[safeCode] };
  }
  return { code: "TEMPORARY_FAILURE", ...SAFE_GATEWAY_ERRORS.TEMPORARY_FAILURE };
}
