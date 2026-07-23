import { describe, expect, it } from "vitest";

import { parseAmazonOperationOutput, safeGatewayError } from "./output";

const money = { amount: "41.92", currency: "USD" } as const;
const item = { title: "Fictional household item", asin: "B0ABC12345", quantity: 2 };
const summary = {
  order_id: "123-1234567-1234567",
  ordered_on: "2026-07-01",
  total: money,
  status: "delivered" as const,
  status_label: "Delivered",
  item_previews: [item],
};
const detail = {
  order_id: "123-1234567-1234567",
  ordered_on: "2026-07-01",
  total: money,
  items: [item],
  shipments: [
    {
      status: "delivered" as const,
      status_label: "Delivered",
      total: money,
      items: [item],
    },
  ],
  price_breakdown: {
    item_subtotal: money,
    shipping: null,
    tax: null,
    discounts: { amount: "-1.00", currency: "USD" as const },
    order_total: money,
  },
};

describe("MCP operation output boundary", () => {
  it("accepts each exact, allowlisted operation result", () => {
    expect(
      parseAmazonOperationOutput(
        { action: "session_status" },
        {
          state: "authenticated",
          profile_alias: "amazon-primary",
          checked_at: "2026-07-21T00:00:00.000Z",
        },
      ),
    ).toBeDefined();
    expect(
      parseAmazonOperationOutput(
        { action: "list_orders", limit: 20, maxPages: 3 },
        { orders: [summary], has_more: false },
      ),
    ).toBeDefined();
    expect(
      parseAmazonOperationOutput(
        { action: "get_order", orderId: summary.order_id },
        { order: detail },
      ),
    ).toBeDefined();
    expect(
      parseAmazonOperationOutput(
        {
          action: "find_orders",
          amount: "41.92",
          currency: "USD",
          dateWindowDays: 14,
          amountTolerance: "0.00",
          limit: 10,
          maxPages: 3,
        },
        {
          status: "unique",
          candidates: [
            {
              order: detail,
              score: 1,
              matched_on: ["amount"],
              amount_source: "order_total",
              amount_delta: { amount: "0.00", currency: "USD" },
              date_delta_days: null,
            },
          ],
        },
      ),
    ).toBeDefined();
  });

  it.each([
    ["url", "https://www.amazon.com/private"],
    ["raw_html", "<html>private</html>"],
    ["connect_url", "wss://connect.browserbase.com/private"],
    ["cookies", [{ name: "session", value: "private" }]],
  ])("rejects an extra %s field", (field, value) => {
    expect(
      parseAmazonOperationOutput(
        { action: "list_orders", limit: 20, maxPages: 3 },
        { orders: [{ ...summary, [field]: value }], has_more: false },
      ),
    ).toBeUndefined();
  });

  it("maps only allowlisted error codes to fixed messages", () => {
    expect(safeGatewayError("LOGIN_REQUIRED")).toEqual({
      code: "LOGIN_REQUIRED",
      message: "Amazon sign-in is required.",
      userActionRequired: true,
    });
    expect(safeGatewayError("BROWSER_QUOTA_EXHAUSTED")).toEqual({
      code: "BROWSER_QUOTA_EXHAUSTED",
      message: "Browserbase browser-minute quota is exhausted.",
      userActionRequired: true,
    });
    expect(safeGatewayError("bb_live_secret raw html")).toEqual({
      code: "TEMPORARY_FAILURE",
      message: "The Amazon browser service is temporarily unavailable.",
      userActionRequired: false,
    });
  });
});
