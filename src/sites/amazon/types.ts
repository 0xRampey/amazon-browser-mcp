export const AMAZON_TEXT_LIMITS = {
  itemTitle: 500,
  shipmentStatus: 120,
  itemQuery: 200,
} as const;

export interface AmazonUsdAmount {
  currency: "USD";
  cents: number;
  decimal: string;
}

export interface AmazonOrderItem {
  title: string;
  asin: string;
  quantity: number;
}

export type AmazonOrderStatus =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "returned"
  | "refunded"
  | "unknown";

export interface AmazonShipment {
  status: AmazonOrderStatus;
  statusLabel: string;
  total?: AmazonUsdAmount;
  items: AmazonOrderItem[];
}

export interface AmazonPriceBreakdown {
  itemSubtotal?: AmazonUsdAmount;
  shipping?: AmazonUsdAmount;
  tax?: AmazonUsdAmount;
  discounts?: AmazonUsdAmount;
  orderTotal: AmazonUsdAmount;
}

export interface AmazonOrderSummary {
  orderId: string;
  orderDate: string;
  orderTotal: AmazonUsdAmount;
  status: AmazonOrderStatus;
  statusLabel: string;
  items: AmazonOrderItem[];
}

export interface AmazonOrderDetail {
  orderId: string;
  orderDate: string;
  orderTotal: AmazonUsdAmount;
  shipments: AmazonShipment[];
  priceBreakdown?: AmazonPriceBreakdown;
}

export type AmazonOrder = AmazonOrderSummary | AmazonOrderDetail;

export type AmazonPageKind =
  | "orders_list"
  | "order_detail"
  | "signed_out"
  | "challenge"
  | "unrecognized";

export interface RawAmazonItem {
  title: string[];
  asin: string[];
  quantity: string[];
}

export interface RawAmazonShipment {
  status: string[];
  total: string[];
  items: RawAmazonItem[];
}

export interface RawAmazonPriceBreakdown {
  itemSubtotal: string[];
  shipping: string[];
  tax: string[];
  discounts: string[];
  orderTotal: string[];
}

export interface RawAmazonOrderSummary {
  orderId: string[];
  orderDate: string[];
  orderTotal: string[];
  status: string[];
  items: RawAmazonItem[];
}

export interface RawAmazonOrderDetail {
  orderId: string[];
  orderDate: string[];
  orderTotal: string[];
  shipments: RawAmazonShipment[];
  priceBreakdown?: RawAmazonPriceBreakdown;
}

export type RawAmazonOrderListCollection =
  | { kind: "signed_out" | "challenge" | "order_detail" | "unrecognized" }
  | {
      kind: "orders_list";
      rootCount: number;
      emptyMarker: boolean;
      /** Internal navigation cursor. Never copy this into normalized MCP output. */
      nextPagePath: string | null;
      orders: RawAmazonOrderSummary[];
    };

export type RawAmazonOrderDetailCollection =
  | { kind: "signed_out" | "challenge" | "orders_list" | "unrecognized" }
  | {
      kind: "order_detail";
      rootCount: number;
      order: RawAmazonOrderDetail;
    };

export type AmazonParseErrorCode =
  | "SIGNED_OUT"
  | "CHALLENGE"
  | "UNRECOGNIZED_LAYOUT"
  | "MISSING_FIELD"
  | "CONFLICTING_FIELD"
  | "INVALID_FIELD";

export interface AmazonOrderMatchCriteria {
  /** Decimal dollars, for example `"41.92"` or `"$41.92"`. */
  amountUsd?: string;
  /** Exact integer cents. May be supplied instead of amountUsd. */
  amountCents?: number;
  /** ISO calendar date (YYYY-MM-DD). */
  orderDate?: string;
  /** Symmetric calendar-day window around orderDate. Defaults to zero. */
  dateWindowDays?: number;
  itemQuery?: string;
  limit?: number;
}

export type AmazonAmountMatchSource =
  | { kind: "order_total" }
  | { kind: "shipment_total"; shipmentIndex: number }
  | { kind: "shipment_sum" };

export interface AmazonOrderMatch {
  order: AmazonOrder;
  matchedAmount: AmazonUsdAmount;
  matchedAmountSource: AmazonAmountMatchSource;
  dateDistanceDays?: number;
}
