import {
  evaluateAmazonNavigationTarget,
  normalizeAmazonMarketplace,
} from "../../browser/request-guard";
import { AmazonOperationError } from "./operations";

const ORDER_ID_PATTERN = /^\d{3}-\d{7}-\d{7}$/;
const ORDER_HISTORY_PATH = "/gp/your-account/order-history";
const ORDER_HISTORY_PATHS = new Set([
  ORDER_HISTORY_PATH,
  "/gp/css/order-history",
  "/your-orders/orders",
]);
const ORDER_DETAIL_PATH = "/gp/your-account/order-details";
const PAGINATION_QUERY_KEYS = new Set([
  "orderFilter",
  "startIndex",
  "timeFilter",
  "page",
  "ref",
  "ref_",
]);

export function buildAmazonOrderHistoryUrl(marketplace: string): string {
  const host = requireMarketplace(marketplace);
  return `https://${host}${ORDER_HISTORY_PATH}`;
}

export function buildAmazonOrderDetailUrl(marketplace: string, orderId: string): string {
  if (!ORDER_ID_PATTERN.test(orderId)) {
    throw new AmazonOperationError("POLICY_BLOCKED");
  }
  const host = requireMarketplace(marketplace);
  const url = new URL(`https://${host}${ORDER_DETAIL_PATH}`);
  url.searchParams.set("orderID", orderId);
  return url.href;
}

/**
 * Resolve an Amazon-supplied pagination path without ever accepting a host,
 * credentials, fragment, or arbitrary query surface from the page.
 */
export function buildAmazonPaginationUrl(
  marketplace: string,
  nextPagePath: string,
): string {
  const host = requireMarketplace(marketplace);
  if (
    nextPagePath.length < 1 ||
    nextPagePath.length > 2_048 ||
    !nextPagePath.startsWith("/") ||
    nextPagePath.startsWith("//")
  ) {
    throw new AmazonOperationError("PARSER_DRIFT");
  }

  let url: URL;
  try {
    url = new URL(nextPagePath, `https://${host}`);
  } catch {
    throw new AmazonOperationError("PARSER_DRIFT");
  }

  if (url.hostname !== host || url.hash || !ORDER_HISTORY_PATHS.has(url.pathname)) {
    throw new AmazonOperationError("POLICY_BLOCKED");
  }
  for (const key of url.searchParams.keys()) {
    if (!PAGINATION_QUERY_KEYS.has(key)) {
      throw new AmazonOperationError("POLICY_BLOCKED");
    }
  }

  const decision = evaluateAmazonNavigationTarget(url.href, host);
  if (!decision.allow) {
    throw new AmazonOperationError("POLICY_BLOCKED");
  }
  return url.href;
}

function requireMarketplace(marketplace: string): string {
  const host = normalizeAmazonMarketplace(marketplace);
  if (!host) {
    throw new AmazonOperationError("POLICY_BLOCKED");
  }
  return host;
}
