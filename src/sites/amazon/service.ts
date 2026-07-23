import puppeteer, {
  type Browser,
  type HTTPRequest,
  type Page,
} from "@cloudflare/puppeteer";

import {
  BrowserbaseSessionError,
  createBrowserbaseSession,
  releaseBrowserbaseSession,
} from "../../browser/browserbase";
import { createNativeWebSocketTransport } from "../../browser/native-websocket-transport";
import { evaluateAmazonRequest, isAmazonAuthenticationUrl } from "../../browser/request-guard";
import type { Env } from "../../env";
import {
  AmazonParseError,
  collectAmazonOrderDetail,
  collectAmazonOrderList,
  collectAmazonPageKind,
  parseAmazonOrderDetail,
  parseAmazonOrderList,
  parseUsdCents,
  sanitizeAmazonText,
  usdAmountFromCents,
} from "./parser";
import {
  AmazonOperationError,
  type AmazonInternalOperation,
} from "./operations";
import type {
  AmazonOrder,
  AmazonOrderDetail,
  AmazonOrderItem,
  AmazonOrderStatus,
  AmazonOrderSummary,
  AmazonShipment,
  AmazonUsdAmount,
  RawAmazonOrderDetailCollection,
  RawAmazonOrderListCollection,
} from "./types";
import {
  buildAmazonOrderDetailUrl,
  buildAmazonOrderHistoryUrl,
  buildAmazonPaginationUrl,
} from "./urls";

const NAVIGATION_TIMEOUT_MS = 45_000;
const DOM_READY_TIMEOUT_MS = 12_000;
const PROTOCOL_TIMEOUT_MS = 60_000;
const MAX_DETAIL_FALLBACKS = 10;

const PAGE_READY_SELECTOR = [
  "[data-amazon-orders-list]",
  "[data-amazon-order-detail]",
  ".order-card",
  ".js-order-card",
  ".a-box-group.order",
  "#orderDetails",
  ".order-details-container",
  "form[action*='/ap/signin']",
  "form[action*='/errors/validateCaptcha']",
  "#captchacharacters",
].join(",");

interface PageGuardState {
  blockedNavigation: boolean;
}

interface CollectedOrderPage {
  orders: AmazonOrderSummary[];
  hasMore: boolean;
}

export async function executeAmazonOperation(
  env: Env,
  request: AmazonInternalOperation,
): Promise<Record<string, unknown>> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let transport: Awaited<ReturnType<typeof createNativeWebSocketTransport>> | undefined;
  let sessionId: string | undefined;

  try {
    const session = await createBrowserbaseSession({
      apiKey: env.BROWSERBASE_API_KEY,
      contextId: env.AMAZON_CONTEXT_ID,
      region: env.BROWSERBASE_REGION,
      timeoutSeconds: 180,
    });
    sessionId = session.id;

    transport = await createNativeWebSocketTransport(session.connectUrl);
    browser = await puppeteer.connect({
      transport,
      defaultViewport: { width: 1_440, height: 1_000 },
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
    });
    page = await createGuardedPage(browser, env.AMAZON_MARKETPLACE);

    switch (request.action) {
      case "session_status":
        return await getSessionStatus(page, env.AMAZON_MARKETPLACE);
      case "list_orders":
        return await listOrders(page, env.AMAZON_MARKETPLACE, request);
      case "get_order":
        return await getOrder(page, env.AMAZON_MARKETPLACE, request.orderId);
      case "find_orders":
        return await findOrders(page, env.AMAZON_MARKETPLACE, request);
    }
    throw new AmazonOperationError("POLICY_BLOCKED");
  } catch (error) {
    throw mapServiceError(error);
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    transport?.close();
    if (sessionId) {
      await releaseBrowserbaseSession({
        apiKey: env.BROWSERBASE_API_KEY,
        sessionId,
      }).catch(() => undefined);
    }
  }
}

export async function createGuardedPage(browser: Browser, marketplace: string): Promise<Page> {
  const existingPages = await browser.pages();
  for (const existing of existingPages) {
    await existing.close().catch(() => undefined);
  }
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  page.setDefaultTimeout(DOM_READY_TIMEOUT_MS);

  // The extractor reads server-rendered order HTML and evaluates only our own
  // collector functions over the finished DOM. Disabling site JavaScript keeps
  // Amazon scripts from opening an unguarded popup, submitting a form, or
  // issuing background requests; `page.evaluate` remains available over CDP.
  await page.setJavaScriptEnabled(false);

  const client = await page.createCDPSession();
  await Promise.all([
    client.send("Network.setBypassServiceWorker", { bypass: true }),
    client.send("Network.setCacheDisabled", { cacheDisabled: true }),
    client.send("Browser.setDownloadBehavior", { behavior: "deny" }),
  ]);

  const guardState: PageGuardState = { blockedNavigation: false };
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void handleRequest(request, marketplace, guardState);
  });
  page.on("popup", (popup) => {
    if (popup) void popup.close().catch(() => undefined);
  });

  Reflect.set(page, "__amazonGuardState", guardState);
  return page;
}

async function handleRequest(
  request: HTTPRequest,
  marketplace: string,
  state: PageGuardState,
): Promise<void> {
  try {
    const decision = evaluateAmazonRequest(
      {
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        isNavigationRequest: request.isNavigationRequest(),
      },
      marketplace,
    );

    if (decision.allow) {
      await request.continue();
      return;
    }
    if (request.isNavigationRequest()) {
      state.blockedNavigation = true;
    }
    await request.abort("blockedbyclient");
  } catch {
    if (request.isNavigationRequest()) {
      state.blockedNavigation = true;
    }
    await request.abort("blockedbyclient").catch(() => undefined);
  }
}

async function navigate(page: Page, url: string, marketplace: string): Promise<void> {
  const state = Reflect.get(page, "__amazonGuardState") as PageGuardState | undefined;
  if (state) state.blockedNavigation = false;

  let response;
  try {
    response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  } catch {
    if (state?.blockedNavigation) throw new AmazonOperationError("POLICY_BLOCKED");
    throw new AmazonOperationError("TEMPORARY_FAILURE");
  }

  const status = response?.status();
  if (status === 429) throw new AmazonOperationError("RATE_LIMITED");
  if (status !== undefined && status >= 500) {
    throw new AmazonOperationError("TEMPORARY_FAILURE");
  }
  if (status === 404) throw new AmazonOperationError("NOT_FOUND");

  const finalUrl = page.url();
  const finalDecision = evaluateAmazonRequest(
    {
      url: finalUrl,
      method: "GET",
      resourceType: "document",
      isNavigationRequest: true,
    },
    marketplace,
  );
  if (!finalDecision.allow) throw new AmazonOperationError("POLICY_BLOCKED");

  await page.waitForSelector(PAGE_READY_SELECTOR, { timeout: DOM_READY_TIMEOUT_MS }).catch(() => null);
}

async function getSessionStatus(page: Page, marketplace: string): Promise<Record<string, unknown>> {
  await navigate(page, buildAmazonOrderHistoryUrl(marketplace), marketplace);
  const kind = await page.evaluate(collectAmazonPageKind as () => ReturnType<typeof collectAmazonPageKind>);
  const url = page.url();
  const state =
    kind === "signed_out" || isAmazonAuthenticationUrl(url, marketplace)
      ? "login_required"
      : kind === "challenge"
        ? "challenge_required"
        : kind === "orders_list"
          ? "authenticated"
          : "unavailable";

  return {
    state,
    profile_alias: "amazon-primary",
    checked_at: new Date().toISOString(),
  };
}

async function listOrders(
  page: Page,
  marketplace: string,
  request: Extract<AmazonInternalOperation, { action: "list_orders" }>,
): Promise<Record<string, unknown>> {
  const collected = await collectOrderPages(page, marketplace, request.maxPages);
  const filtered = collected.orders.filter((order) => {
    if (request.orderedFrom && order.orderDate < request.orderedFrom) return false;
    if (request.orderedTo && order.orderDate > request.orderedTo) return false;
    if (request.statuses && !request.statuses.includes(order.status)) return false;
    return true;
  });
  const orders = filtered.slice(0, request.limit);

  return {
    orders: orders.map(toOrderSummaryResult),
    has_more: collected.hasMore || filtered.length > request.limit,
  };
}

async function getOrder(
  page: Page,
  marketplace: string,
  orderId: string,
): Promise<Record<string, unknown>> {
  const order = await readOrderDetail(page, marketplace, orderId);
  return { order: toOrderDetailResult(order) };
}

async function findOrders(
  page: Page,
  marketplace: string,
  request: Extract<AmazonInternalOperation, { action: "find_orders" }>,
): Promise<Record<string, unknown>> {
  let candidates: AmazonOrder[];
  if (request.orderId) {
    candidates = [await readOrderDetail(page, marketplace, request.orderId)];
  } else {
    candidates = (await collectOrderPages(page, marketplace, request.maxPages)).orders;
  }

  const targetDate = request.orderedOn;
  const query = request.itemQuery
    ? sanitizeAmazonText(request.itemQuery, 100).toLocaleLowerCase("en-US")
    : undefined;
  candidates = candidates.filter((order) => {
    if (targetDate && dateDistanceDays(order.orderDate, targetDate) > request.dateWindowDays) {
      return false;
    }
    if (query && !getOrderItems(order).some((item) => item.title.toLocaleLowerCase("en-US").includes(query))) {
      return false;
    }
    return true;
  });

  const targetCents = request.amount === undefined ? undefined : parseUsdCents(request.amount);
  const toleranceCents = parseUsdCents(request.amountTolerance);

  if (targetCents !== undefined) {
    const detailCandidates: AmazonOrder[] = [];
    for (const candidate of candidates.slice(0, MAX_DETAIL_FALLBACKS)) {
      if ("shipments" in candidate) {
        detailCandidates.push(candidate);
        continue;
      }
      try {
        detailCandidates.push(await readOrderDetail(page, marketplace, candidate.orderId));
      } catch (error) {
        if (error instanceof AmazonOperationError && error.code === "NOT_FOUND") {
          detailCandidates.push(candidate);
          continue;
        }
        throw error;
      }
    }
    candidates = detailCandidates;
  }

  const results = candidates
    .map((order) => rankCandidate(order, request, targetCents, toleranceCents, query))
    .filter((candidate): candidate is RankedCandidate => candidate !== undefined)
    .sort(compareRankedCandidates)
    .slice(0, request.limit);

  const best = results[0];
  const equallyStrong = best
    ? results.filter(
        (candidate) =>
          candidate.score === best.score &&
          candidate.amountDeltaCents === best.amountDeltaCents &&
          candidate.dateDeltaDays === best.dateDeltaDays,
      ).length
    : 0;

  return {
    status: results.length === 0 ? "none" : equallyStrong === 1 ? "unique" : "ambiguous",
    candidates: results.map((candidate) => ({
      order: toCommonOrderResult(candidate.order),
      score: candidate.score,
      matched_on: candidate.matchedOn,
      amount_source: candidate.amountSource,
      amount_delta:
        candidate.amountDeltaCents === null
          ? null
          : toMoneyResult(usdAmountFromCents(candidate.amountDeltaCents)),
      date_delta_days: candidate.dateDeltaDays,
    })),
  };
}

async function collectOrderPages(
  page: Page,
  marketplace: string,
  maxPages: number,
): Promise<CollectedOrderPage> {
  const orders = new Map<string, AmazonOrderSummary>();
  let url = buildAmazonOrderHistoryUrl(marketplace);
  let hasMore = false;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    await navigate(page, url, marketplace);
    const collection = await page.evaluate(
      collectAmazonOrderList as () => RawAmazonOrderListCollection,
    );
    const pageOrders = parseAmazonOrderList(collection);
    for (const order of pageOrders) {
      const previous = orders.get(order.orderId);
      if (previous && !sameOrderSummary(previous, order)) {
        throw new AmazonOperationError("PARSER_DRIFT");
      }
      orders.set(order.orderId, order);
    }

    if (collection.kind !== "orders_list" || collection.nextPagePath === null) {
      hasMore = false;
      break;
    }
    hasMore = true;
    if (pageNumber + 1 >= maxPages) break;
    url = buildAmazonPaginationUrl(marketplace, collection.nextPagePath);
  }

  return { orders: [...orders.values()], hasMore };
}

async function readOrderDetail(
  page: Page,
  marketplace: string,
  orderId: string,
): Promise<AmazonOrderDetail> {
  await navigate(page, buildAmazonOrderDetailUrl(marketplace, orderId), marketplace);
  const collection = await page.evaluate(
    collectAmazonOrderDetail as () => RawAmazonOrderDetailCollection,
  );
  const order = parseAmazonOrderDetail(collection);
  if (order.orderId !== orderId) throw new AmazonOperationError("PARSER_DRIFT");
  return order;
}

interface RankedCandidate {
  order: AmazonOrder;
  score: number;
  matchedOn: string[];
  amountSource: string | null;
  amountDeltaCents: number | null;
  dateDeltaDays: number | null;
}

function rankCandidate(
  order: AmazonOrder,
  request: Extract<AmazonInternalOperation, { action: "find_orders" }>,
  targetCents: number | undefined,
  toleranceCents: number,
  query: string | undefined,
): RankedCandidate | undefined {
  const matchedOn: string[] = [];
  let matchedCriteria = 0;
  let totalCriteria = 0;

  if (request.orderId) {
    totalCriteria += 1;
    if (order.orderId !== request.orderId) return undefined;
    matchedOn.push("order_id");
    matchedCriteria += 1;
  }

  const dateDelta = request.orderedOn
    ? dateDistanceDays(order.orderDate, request.orderedOn)
    : null;
  if (request.orderedOn) {
    totalCriteria += 1;
    if (dateDelta === null || dateDelta > request.dateWindowDays) return undefined;
    matchedOn.push("date");
    matchedCriteria += 1;
  }

  if (query) {
    totalCriteria += 1;
    if (!getOrderItems(order).some((item) => item.title.toLocaleLowerCase("en-US").includes(query))) {
      return undefined;
    }
    matchedOn.push("item_title");
    matchedCriteria += 1;
  }

  let amountDeltaCents: number | null = null;
  let amountSource: string | null = null;
  if (targetCents !== undefined) {
    totalCriteria += 1;
    const amounts = getOrderAmounts(order)
      .map((entry) => ({ ...entry, delta: Math.abs(entry.amount.cents - targetCents) }))
      .sort((left, right) => left.delta - right.delta || left.rank - right.rank);
    const closest = amounts[0];
    if (!closest || closest.delta > toleranceCents) return undefined;
    amountDeltaCents = closest.delta;
    amountSource = closest.source;
    matchedOn.push("amount");
    matchedCriteria += 1;
  }

  return {
    order,
    score: totalCriteria === 0 ? 0 : matchedCriteria / totalCriteria,
    matchedOn,
    amountSource,
    amountDeltaCents,
    dateDeltaDays: dateDelta,
  };
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  if ((left.amountDeltaCents ?? 0) !== (right.amountDeltaCents ?? 0)) {
    return (left.amountDeltaCents ?? 0) - (right.amountDeltaCents ?? 0);
  }
  if ((left.dateDeltaDays ?? 0) !== (right.dateDeltaDays ?? 0)) {
    return (left.dateDeltaDays ?? 0) - (right.dateDeltaDays ?? 0);
  }
  return left.order.orderId.localeCompare(right.order.orderId);
}

function getOrderAmounts(order: AmazonOrder): Array<{
  amount: AmazonUsdAmount;
  source: string;
  rank: number;
}> {
  const amounts = [{ amount: order.orderTotal, source: "order_total", rank: 0 }];
  if ("shipments" in order) {
    order.shipments.forEach((shipment, index) => {
      if (shipment.total) {
        amounts.push({ amount: shipment.total, source: `shipment_${index + 1}_total`, rank: 1 });
      }
    });
  }
  return amounts;
}

function getOrderItems(order: AmazonOrder): AmazonOrderItem[] {
  return "shipments" in order
    ? order.shipments.flatMap((shipment) => shipment.items)
    : order.items;
}

function sameOrderSummary(left: AmazonOrderSummary, right: AmazonOrderSummary): boolean {
  return (
    left.orderDate === right.orderDate &&
    left.orderTotal.cents === right.orderTotal.cents &&
    left.status === right.status &&
    JSON.stringify(left.items) === JSON.stringify(right.items)
  );
}

function toOrderSummaryResult(order: AmazonOrderSummary): Record<string, unknown> {
  return {
    order_id: order.orderId,
    ordered_on: order.orderDate,
    total: toMoneyResult(order.orderTotal),
    status: order.status,
    status_label: order.statusLabel,
    item_previews: order.items.map(toItemResult),
  };
}

function toOrderDetailResult(order: AmazonOrderDetail): Record<string, unknown> {
  return {
    order_id: order.orderId,
    ordered_on: order.orderDate,
    total: toMoneyResult(order.orderTotal),
    items: getOrderItems(order).map(toItemResult),
    shipments: order.shipments.map(toShipmentResult),
    price_breakdown: order.priceBreakdown
      ? {
          item_subtotal: order.priceBreakdown.itemSubtotal
            ? toMoneyResult(order.priceBreakdown.itemSubtotal)
            : null,
          shipping: order.priceBreakdown.shipping
            ? toMoneyResult(order.priceBreakdown.shipping)
            : null,
          tax: order.priceBreakdown.tax ? toMoneyResult(order.priceBreakdown.tax) : null,
          discounts: order.priceBreakdown.discounts
            ? toMoneyResult(order.priceBreakdown.discounts)
            : null,
          order_total: toMoneyResult(order.priceBreakdown.orderTotal),
        }
      : null,
  };
}

function toCommonOrderResult(order: AmazonOrder): Record<string, unknown> {
  return "shipments" in order ? toOrderDetailResult(order) : toOrderSummaryResult(order);
}

function toShipmentResult(shipment: AmazonShipment): Record<string, unknown> {
  return {
    status: shipment.status,
    status_label: shipment.statusLabel,
    total: shipment.total ? toMoneyResult(shipment.total) : null,
    items: shipment.items.map(toItemResult),
  };
}

function toItemResult(item: AmazonOrderItem): Record<string, unknown> {
  return { title: item.title, asin: item.asin, quantity: item.quantity };
}

function toMoneyResult(amount: AmazonUsdAmount): Record<string, unknown> {
  return { amount: amount.decimal, currency: amount.currency };
}

function dateDistanceDays(left: string, right: string): number {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    throw new AmazonOperationError("PARSER_DRIFT");
  }
  return Math.abs(Math.round((leftTime - rightTime) / 86_400_000));
}

function mapServiceError(error: unknown): AmazonOperationError {
  if (error instanceof AmazonOperationError) return error;
  if (error instanceof AmazonParseError) {
    switch (error.code) {
      case "SIGNED_OUT":
        return new AmazonOperationError("LOGIN_REQUIRED");
      case "CHALLENGE":
        return new AmazonOperationError("CHALLENGE_REQUIRED");
      default:
        return new AmazonOperationError("PARSER_DRIFT");
    }
  }
  if (error instanceof BrowserbaseSessionError) {
    if (error.code === "rate_limited") {
      return new AmazonOperationError("RATE_LIMITED");
    }
    if (error.code === "quota_exhausted") {
      return new AmazonOperationError("BROWSER_QUOTA_EXHAUSTED");
    }
    return new AmazonOperationError("TEMPORARY_FAILURE");
  }
  return new AmazonOperationError("TEMPORARY_FAILURE");
}
