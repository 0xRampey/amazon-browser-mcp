import { readFileSync } from "node:fs";

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import {
  AmazonParseError,
  collectAmazonOrderDetail,
  collectAmazonOrderList,
  collectAmazonPageKind,
  matchAmazonOrders,
  parseAmazonOrderDetail,
  parseAmazonOrderDetailDocument,
  parseAmazonOrderList,
  parseAmazonOrderListDocument,
  parseUsdCents,
  sanitizeAmazonText,
  usdAmountFromCents,
} from "./parser";
import type {
  AmazonOrderDetail,
  AmazonParseErrorCode,
  RawAmazonOrderListCollection,
} from "./types";

function fixtureDocument(name: string): Document {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return parseHTML(html).document as unknown as Document;
}

function documentFrom(html: string): Document {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document;
}

function expectParseError(run: () => unknown, code: AmazonParseErrorCode): void {
  try {
    run();
    throw new Error(`Expected AmazonParseError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(AmazonParseError);
    expect((error as AmazonParseError).code).toBe(code);
    expect((error as AmazonParseError).message).not.toContain("Fictional");
  }
}

function rawStatusList(statuses: readonly string[]): RawAmazonOrderListCollection {
  return {
    kind: "orders_list",
    rootCount: 1,
    emptyMarker: false,
    nextPagePath: null,
    orders: statuses.map((status, index) => {
      const sequence = String(index + 1).padStart(7, "0");
      return {
        orderId: [`900-${sequence}-${sequence}`],
        orderDate: ["2026-07-01"],
        orderTotal: ["$1.00"],
        status: [status],
        items: [
          {
            title: [`Fictional Status Item ${index + 1}`],
            asin: [`B0STAT${String(index + 1).padStart(4, "0")}`],
            quantity: ["1"],
          },
        ],
      };
    }),
  };
}

describe("Amazon page classification", () => {
  it.each([
    ["orders-list.html", "orders_list"],
    ["orders-list-fallback.html", "orders_list"],
    ["orders-empty.html", "orders_list"],
    ["order-detail.html", "order_detail"],
    ["order-detail-fallback.html", "order_detail"],
    ["signed-out.html", "signed_out"],
    ["challenge.html", "challenge"],
  ] as const)("classifies %s as %s", (fixture, kind) => {
    expect(collectAmazonPageKind(fixtureDocument(fixture))).toBe(kind);
  });

  it("recognizes a production-style list with multiple order cards", () => {
    const document = fixtureDocument("orders-list-fallback.html");
    expect(document.querySelectorAll(".order-card, .js-order-card")).toHaveLength(2);
    expect(collectAmazonPageKind(document)).toBe("orders_list");
  });

  it("fails closed when list and detail roots coexist", () => {
    const document = documentFrom(`
      <main data-amazon-orders-list><article data-order-card></article></main>
      <section data-amazon-order-detail></section>
    `);
    expect(collectAmazonPageKind(document)).toBe("unrecognized");
    expect(collectAmazonOrderList(document)).toEqual({ kind: "unrecognized" });
    expect(collectAmazonOrderDetail(document)).toEqual({ kind: "unrecognized" });
  });

  it("does not infer an order page from unrelated markup", () => {
    const document = documentFrom(`<main><h1>Your account</h1><p>No order structure here.</p></main>`);
    expect(collectAmazonPageKind(document)).toBe("unrecognized");
    expect(collectAmazonOrderList(document)).toEqual({ kind: "unrecognized" });
    expect(collectAmazonOrderDetail(document)).toEqual({ kind: "unrecognized" });
  });
});

describe("Amazon order-list fixtures", () => {
  it("normalizes only allowlisted fields from the synthetic fixture", () => {
    const document = fixtureDocument("orders-list.html");
    const collection = collectAmazonOrderList(document);
    expect(collection.kind).toBe("orders_list");
    if (collection.kind !== "orders_list") throw new Error("unexpected collection kind");
    expect(collection.nextPagePath).toBe(
      "/gp/your-account/order-history?startIndex=10",
    );

    const orders = parseAmazonOrderList(collection);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toEqual({
      orderId: "111-1111111-1111111",
      orderDate: "2026-07-04",
      orderTotal: { currency: "USD", cents: 4_192, decimal: "41.92" },
      status: "delivered",
      statusLabel: "Delivered July 6",
      items: [
        {
          title: "Fancy Towels Pack",
          asin: "B0TEST0001",
          quantity: 2,
        },
      ],
    });
    expect(orders[1]?.status).toBe("shipped");

    const serialized = JSON.stringify(orders);
    expect(serialized).not.toContain("Fictional Street");
    expect(serialized).not.toContain("Card ending");
    expect(serialized).not.toContain("TRACKING");
    expect(serialized).not.toContain("reveal the shipping address");
  });

  it("parses multiple production-selector cards and ignores arbitrary detail-link text", () => {
    const document = fixtureDocument("orders-list-fallback.html");
    const collection = collectAmazonOrderList(document);
    expect(collection.kind).toBe("orders_list");
    if (collection.kind !== "orders_list") throw new Error("unexpected collection kind");

    expect(collection.orders).toHaveLength(2);
    expect(collection.orders[0]?.orderId).toEqual(["555-5555555-5555555"]);
    expect(collection.orders[1]?.orderId).toEqual(["777-7777777-7777777"]);
    expect(collection.orders.flatMap((order) => order.orderId)).not.toContain(
      "View order details",
    );
    expect(collection.orders.flatMap((order) => order.orderId)).not.toContain("Details");

    expect(parseAmazonOrderList(collection)).toEqual([
      {
        orderId: "555-5555555-5555555",
        orderDate: "2026-07-12",
        orderTotal: { currency: "USD", cents: 2_840, decimal: "28.40" },
        status: "delivered",
        statusLabel: "Delivered July 14",
        items: [
          {
            title: "Fictional Selector-Test Notebook",
            asin: "B0TEST0006",
            quantity: 2,
          },
        ],
      },
      {
        orderId: "777-7777777-7777777",
        orderDate: "2026-07-10",
        orderTotal: { currency: "USD", cents: 1_705, decimal: "17.05" },
        status: "refunded",
        statusLabel: "Refund issued",
        items: [
          {
            title: "Fictional Selector-Test Cable",
            asin: "B0TEST0008",
            quantity: 1,
          },
        ],
      },
    ]);
  });

  it("returns an empty list only with an explicit empty marker", () => {
    expect(parseAmazonOrderListDocument(fixtureDocument("orders-empty.html"))).toEqual([]);
    expectParseError(
      () =>
        parseAmazonOrderList({
          kind: "orders_list",
          rootCount: 1,
          emptyMarker: false,
          nextPagePath: null,
          orders: [],
        }),
      "UNRECOGNIZED_LAYOUT",
    );
  });

  it("rejects conflicting fixture values instead of guessing", () => {
    expectParseError(
      () => parseAmazonOrderListDocument(fixtureDocument("layout-drift.html")),
      "CONFLICTING_FIELD",
    );
  });

  it("rejects malformed IDs without treating link labels as identifiers", () => {
    const document = documentFrom(`
      <article class="order-card">
        <span>ORDER PLACED</span><span>July 12, 2026</span>
        <span>ORDER TOTAL</span><span>$8.00</span>
        <a href="/gp/your-account/order-details?orderID=not-an-order-id">View order details</a>
        <span class="order-status">Delivered</span>
        <div class="a-row"><a href="/dp/B0TEST0099">Fictional Item</a></div>
      </article>
    `);
    const collection = collectAmazonOrderList(document);
    expect(collection.kind).toBe("orders_list");
    if (collection.kind !== "orders_list") throw new Error("unexpected collection kind");
    expect(collection.orders[0]?.orderId).toEqual(["not-an-order-id"]);
    expect(collection.orders[0]?.orderId).not.toContain("View order details");
    expectParseError(() => parseAmazonOrderList(collection), "INVALID_FIELD");
  });

  it("rejects an off-marketplace order-detail link", () => {
    const document = documentFrom(`
      <article class="order-card">
        <span>ORDER PLACED</span><span>July 12, 2026</span>
        <span>ORDER TOTAL</span><span>$8.00</span>
        <a href="https://example.invalid/order?orderID=123-1234567-1234567">Details</a>
        <span class="order-status">Delivered</span>
        <div class="a-row"><a href="/dp/B0TEST0099">Fictional Item</a></div>
      </article>
    `);
    expectParseError(() => parseAmazonOrderListDocument(document), "MISSING_FIELD");
  });
});

describe("Amazon order-detail fixtures", () => {
  it("parses shipments, quantities, statuses, totals, and price breakdown", () => {
    const detail = parseAmazonOrderDetailDocument(fixtureDocument("order-detail.html"));
    expect(detail).toEqual({
      orderId: "333-3333333-3333333",
      orderDate: "2026-07-09",
      orderTotal: { currency: "USD", cents: 4_467, decimal: "44.67" },
      shipments: [
        {
          status: "delivered",
          statusLabel: "Delivered",
          total: { currency: "USD", cents: 2_500, decimal: "25.00" },
          items: [
            {
              title: "Fictional Kitchen Brush",
              asin: "B0TEST0003",
              quantity: 1,
            },
          ],
        },
        {
          status: "shipped",
          statusLabel: "Shipped",
          total: { currency: "USD", cents: 1_967, decimal: "19.67" },
          items: [
            {
              title: "Fictional Refill Pack",
              asin: "B0TEST0004",
              quantity: 3,
            },
          ],
        },
      ],
      priceBreakdown: {
        itemSubtotal: { currency: "USD", cents: 4_500, decimal: "45.00" },
        shipping: { currency: "USD", cents: 0, decimal: "0.00" },
        tax: { currency: "USD", cents: 467, decimal: "4.67" },
        discounts: { currency: "USD", cents: -500, decimal: "-5.00" },
        orderTotal: { currency: "USD", cents: 4_467, decimal: "44.67" },
      },
    });

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("Imaginary Avenue");
    expect(serialized).not.toContain("Payment method");
    expect(serialized).not.toContain("tracking.invalid");
  });

  it("uses production-style selectors without accepting arbitrary link text", () => {
    const document = fixtureDocument("order-detail-fallback.html");
    const collection = collectAmazonOrderDetail(document);
    expect(collection.kind).toBe("order_detail");
    if (collection.kind !== "order_detail") throw new Error("unexpected collection kind");
    expect(collection.order.orderId).toEqual(["666-6666666-6666666"]);
    expect(collection.order.orderId).not.toContain("View order details");

    const detail = parseAmazonOrderDetail(collection);
    expect(detail.orderId).toBe("666-6666666-6666666");
    expect(detail.orderDate).toBe("2026-07-15");
    expect(detail.orderTotal.cents).toBe(3_310);
    expect(detail.shipments).toEqual([
      {
        status: "shipped",
        statusLabel: "Out for delivery",
        total: { currency: "USD", cents: 3_310, decimal: "33.10" },
        items: [
          {
            title: "Fictional Production-Fallback Item",
            asin: "B0TEST0007",
            quantity: 1,
          },
        ],
      },
    ]);
    expect(detail.priceBreakdown?.orderTotal.cents).toBe(3_310);
    expect(detail.priceBreakdown?.discounts?.cents).toBe(0);
  });

  it("requires at least one shipment and rejects contradictory totals", () => {
    expectParseError(
      () =>
        parseAmazonOrderDetail({
          kind: "order_detail",
          rootCount: 1,
          order: {
            orderId: ["123-1234567-1234567"],
            orderDate: ["2026-07-01"],
            orderTotal: ["$10.00"],
            shipments: [],
          },
        }),
      "UNRECOGNIZED_LAYOUT",
    );

    const collected = collectAmazonOrderDetail(fixtureDocument("order-detail.html"));
    if (collected.kind !== "order_detail") throw new Error("unexpected collection kind");
    collected.order.orderTotal.push("$99.99");
    expectParseError(() => parseAmazonOrderDetail(collected), "CONFLICTING_FIELD");
  });
});

describe("authentication and challenge fixtures", () => {
  it.each([
    ["signed-out.html", "signed_out", "SIGNED_OUT"],
    ["challenge.html", "challenge", "CHALLENGE"],
  ] as const)("returns a safe %s state", (fixture, kind, code) => {
    const document = fixtureDocument(fixture);
    const listCollection = collectAmazonOrderList(document);
    const detailCollection = collectAmazonOrderDetail(document);
    expect(listCollection).toEqual({ kind });
    expect(detailCollection).toEqual({ kind });
    expectParseError(() => parseAmazonOrderList(listCollection), code);
    expectParseError(() => parseAmazonOrderDetail(detailCollection), code);
  });
});

describe("status normalization", () => {
  it("maps known statuses and preserves a bounded human-readable label", () => {
    const labels = [
      "Order received",
      "Preparing for shipment",
      "Out for delivery",
      "Delivered today",
      "Canceled",
      "Return complete",
      "Refund issued",
      "Status unavailable",
    ];
    const orders = parseAmazonOrderList(rawStatusList(labels));
    expect(orders.map((order) => order.status)).toEqual([
      "pending",
      "processing",
      "shipped",
      "delivered",
      "cancelled",
      "returned",
      "refunded",
      "unknown",
    ]);
    expect(orders.map((order) => order.statusLabel)).toEqual(labels);
  });

  it("rejects contradictory status candidates", () => {
    const collection = rawStatusList(["Delivered"]);
    if (collection.kind !== "orders_list") throw new Error("unexpected collection kind");
    collection.orders[0]!.status.push("Canceled");
    expectParseError(() => parseAmazonOrderList(collection), "CONFLICTING_FIELD");
  });
});

describe("text, money, and transaction matching", () => {
  it("normalizes Unicode and strips control, bidi, and zero-width characters", () => {
    expect(sanitizeAmazonText("  Ｆancy\u200b\u202e\n  Towels  ", 100)).toBe(
      "Fancy Towels",
    );
    expect(sanitizeAmazonText("abcdef", 3)).toBe("abc");
  });

  it("parses USD exactly as integer cents and rejects ambiguous values", () => {
    expect(parseUsdCents("Order total: US$1,234.5")).toBe(123_450);
    expect(parseUsdCents("($5.25)", { allowNegative: true })).toBe(-525);
    expect(parseUsdCents("-$0.00", { allowNegative: true })).toBe(0);
    expectParseError(() => parseUsdCents("$1,23.00"), "INVALID_FIELD");
    expectParseError(() => parseUsdCents("€12.00"), "INVALID_FIELD");
    expectParseError(() => parseUsdCents("-$1.00"), "INVALID_FIELD");
  });

  it("matches an exact order, shipment, and shipment sum using cents", () => {
    const order: AmazonOrderDetail = {
      orderId: "333-3333333-3333333",
      orderDate: "2026-07-09",
      orderTotal: usdAmountFromCents(4_467),
      shipments: [
        {
          status: "delivered",
          statusLabel: "Delivered",
          total: usdAmountFromCents(2_500),
          items: [{ title: "Fictional Kitchen Brush", asin: "B0TEST0003", quantity: 1 }],
        },
        {
          status: "shipped",
          statusLabel: "Shipped",
          total: usdAmountFromCents(1_967),
          items: [{ title: "Fictional Refill Pack", asin: "B0TEST0004", quantity: 3 }],
        },
      ],
    };

    expect(matchAmazonOrders([order], { amountCents: 4_467 })[0]?.matchedAmountSource).toEqual({
      kind: "order_total",
    });
    expect(matchAmazonOrders([order], { amountUsd: "$25.00" })[0]?.matchedAmountSource).toEqual({
      kind: "shipment_total",
      shipmentIndex: 0,
    });
    expect(
      matchAmazonOrders([order], {
        amountCents: 4_467,
        orderDate: "2026-07-10",
        dateWindowDays: 1,
        itemQuery: "kitchen",
      }),
    ).toHaveLength(1);
  });
});
