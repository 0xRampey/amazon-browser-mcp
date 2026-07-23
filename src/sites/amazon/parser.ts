import {
  AMAZON_TEXT_LIMITS,
  type AmazonAmountMatchSource,
  type AmazonOrder,
  type AmazonOrderDetail,
  type AmazonOrderItem,
  type AmazonOrderMatch,
  type AmazonOrderMatchCriteria,
  type AmazonOrderStatus,
  type AmazonOrderSummary,
  type AmazonPageKind,
  type AmazonParseErrorCode,
  type AmazonPriceBreakdown,
  type AmazonShipment,
  type AmazonUsdAmount,
  type RawAmazonItem,
  type RawAmazonOrderDetailCollection,
  type RawAmazonOrderListCollection,
  type RawAmazonPriceBreakdown,
  type RawAmazonShipment,
} from "./types";

const ERROR_MESSAGES: Record<AmazonParseErrorCode, string> = {
  SIGNED_OUT: "Amazon sign-in is required.",
  CHALLENGE: "Amazon requires interactive verification.",
  UNRECOGNIZED_LAYOUT: "The Amazon page layout is not recognized.",
  MISSING_FIELD: "A required Amazon order field is missing.",
  CONFLICTING_FIELD: "Conflicting Amazon order values were found.",
  INVALID_FIELD: "An Amazon order field has an invalid value.",
};

const MAX_USD_CENTS = 10_000_000_000;
const ORDER_ID_PATTERN = /^\d{3}-\d{7}-\d{7}$/;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

/** Safe parser failures contain no page-derived text. */
export class AmazonParseError extends Error {
  readonly code: AmazonParseErrorCode;

  constructor(code: AmazonParseErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AmazonParseError";
    this.code = code;
  }
}

/**
 * A self-contained page-evaluate collector. It intentionally returns only a
 * page state, never HTML, URLs, cookies, or visible page text.
 */
export function collectAmazonPageKind(documentRef: Document = document): AmazonPageKind {
  const title = documentRef.title ?? "";
  const challenge =
    documentRef.querySelector(
      '[data-amazon-page="challenge"], form[action*="/errors/validateCaptcha"], input[name="cvf_captcha_input"], #captchacharacters',
    ) !== null || /(?:captcha|robot check|verify your identity)/i.test(title);
  if (challenge) return "challenge";

  const signedOut =
    documentRef.querySelector(
      '[data-amazon-page="sign-in"], form[action*="/ap/signin"], input[name="email"][type="email"]',
    ) !== null || /amazon\s+sign[ -]?in/i.test(title);
  if (signedOut) return "signed_out";

  const syntheticListCount = documentRef.querySelectorAll("[data-amazon-orders-list]").length;
  const detailCandidates = Array.from(
    documentRef.querySelectorAll(
      '[data-amazon-order-detail], #orderDetails, .order-details-container, [data-component="orderDetails"], [data-testid="order-details"]',
    ),
  );
  const productionListCandidates = Array.from(
    documentRef.querySelectorAll(
      '.order-card, .js-order-card, .a-box-group.order, .order-card__list, [data-component="orderCard"]',
    ),
  );
  const productionCandidateOrderIds = productionListCandidates.map((card) => {
    const identifiers: string[] = [
      ...((card.textContent ?? "").match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []),
    ];
    for (const link of card.querySelectorAll(
      'a[href*="orderID="], a[href*="orderId="]',
    )) {
      const href = link.getAttribute("href") ?? "";
      const rawIdentifier = href.match(/[?&]orderI[Dd]=([^&#]+)/)?.[1];
      if (rawIdentifier) {
        try {
          identifiers.push(decodeURIComponent(rawIdentifier));
        } catch {
          identifiers.push(rawIdentifier);
        }
      }
      identifiers.push(
        ...(href.match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []),
      );
    }
    return Array.from(new Set(identifiers));
  });
  const seenProductionOrderIds = new Set<string>();
  const productionListCount = productionCandidateOrderIds.filter((identifiers) => {
    if (identifiers.length !== 1 || seenProductionOrderIds.has(identifiers[0]!)) {
      return false;
    }
    seenProductionOrderIds.add(identifiers[0]!);
    return true;
  }).length;
  const detailCount = detailCandidates.filter(
    (candidate, index) =>
      !detailCandidates.some(
        (other, otherIndex) => otherIndex < index && other.contains(candidate),
      ),
  ).length;
  const listCount = syntheticListCount || productionListCount;
  if (listCount > 0 && detailCount === 0) return "orders_list";
  if (detailCount === 1 && listCount === 0) return "order_detail";
  return "unrecognized";
}

/**
 * Browser-callable collector for an order-history page. Keep this function
 * self-contained: Puppeteer serializes it for page.evaluate without closures.
 */
export function collectAmazonOrderList(
  documentRef: Document = document,
): RawAmazonOrderListCollection {
  const title = documentRef.title ?? "";
  if (
    documentRef.querySelector(
      '[data-amazon-page="challenge"], form[action*="/errors/validateCaptcha"], input[name="cvf_captcha_input"], #captchacharacters',
    ) !== null ||
    /(?:captcha|robot check|verify your identity)/i.test(title)
  ) {
    return { kind: "challenge" };
  }
  if (
    documentRef.querySelector(
      '[data-amazon-page="sign-in"], form[action*="/ap/signin"], input[name="email"][type="email"]',
    ) !== null ||
    /amazon\s+sign[ -]?in/i.test(title)
  ) {
    return { kind: "signed_out" };
  }

  const detailCount = documentRef.querySelectorAll(
    '[data-amazon-order-detail], #orderDetails, .order-details-container, [data-component="orderDetails"]',
  ).length;
  const syntheticRoots = Array.from(
    documentRef.querySelectorAll<HTMLElement>("[data-amazon-orders-list]"),
  );
  const productionCardCandidates = Array.from(
    documentRef.querySelectorAll<HTMLElement>(
      '.order-card, .js-order-card, .a-box-group.order, .order-card__list, [data-component="orderCard"]',
    ),
  );
  const productionCandidateOrderIds = productionCardCandidates.map((card) => {
    const identifiers: string[] = [
      ...((card.textContent ?? "").match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []),
    ];
    for (const link of card.querySelectorAll(
      'a[href*="orderID="], a[href*="orderId="]',
    )) {
      const href = link.getAttribute("href") ?? "";
      const rawIdentifier = href.match(/[?&]orderI[Dd]=([^&#]+)/)?.[1];
      if (rawIdentifier) {
        try {
          identifiers.push(decodeURIComponent(rawIdentifier));
        } catch {
          identifiers.push(rawIdentifier);
        }
      }
      identifiers.push(
        ...(href.match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []),
      );
    }
    return Array.from(new Set(identifiers));
  });
  const seenProductionOrderIds = new Set<string>();
  const productionCards = productionCardCandidates.filter((_candidate, index) => {
    const identifiers = productionCandidateOrderIds[index] ?? [];
    if (identifiers.length !== 1 || seenProductionOrderIds.has(identifiers[0]!)) {
      return false;
    }
    seenProductionOrderIds.add(identifiers[0]!);
    return true;
  });
  if (detailCount > 0 && syntheticRoots.length === 0 && productionCards.length === 0) {
    return { kind: "order_detail" };
  }
  if (detailCount > 0) return { kind: "unrecognized" };
  const root = syntheticRoots[0] ?? documentRef.body;
  if (!root || (syntheticRoots.length === 0 && productionCards.length === 0)) {
    return { kind: "unrecognized" };
  }

  const values = (
    scope: Element,
    selector: string,
    attributes: string[],
    includeText: boolean,
  ): string[] => {
    const nodes: Element[] = [];
    if (scope.matches(selector)) nodes.push(scope);
    nodes.push(...Array.from(scope.querySelectorAll(selector)));
    const result: string[] = [];
    for (const node of nodes) {
      for (const attribute of attributes) {
        const value = node.getAttribute(attribute);
        if (value?.trim()) result.push(value);
      }
      if (includeText && node.children.length === 0) {
        const value = node.textContent;
        if (value?.trim()) result.push(value);
      }
    }
    return result;
  };

  const collectItem = (element: Element): RawAmazonItem => ({
    title: values(element, "[data-item-title]", ["data-item-title"], true),
    asin: values(element, "[data-asin]", ["data-asin"], false),
    quantity: values(element, "[data-quantity]", ["data-quantity"], true),
  });

  const labeledValues = (scope: Element, expectedLabel: RegExp): string[] => {
    const result: string[] = [];
    for (const label of Array.from(scope.querySelectorAll("span, dt, th, div"))) {
      const text = (label.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!expectedLabel.test(text)) continue;
      const sibling =
        label.nextElementSibling ?? label.parentElement?.nextElementSibling ?? null;
      const value = sibling?.textContent;
      if (value?.trim()) result.push(value);
    }
    return result;
  };

  const orderIdsFromLinks = (scope: Element): string[] => {
    const result: string[] = [];
    for (const link of Array.from(
      scope.querySelectorAll<HTMLAnchorElement>(
        'a[href*="orderID="], a[href*="orderId="]',
      ),
    )) {
      const href = link.getAttribute("href");
      if (!href || href.length > 2_048) continue;
      try {
        const url = new URL(href, "https://www.amazon.com");
        if (url.hostname !== "www.amazon.com" && url.hostname !== "amazon.com") continue;
        const id = url.searchParams.get("orderID") ?? url.searchParams.get("orderId");
        if (id) result.push(id);
      } catch {
        // A malformed navigation candidate is ignored; required-field checks fail closed later.
      }
      const linkTextId = link.textContent?.match(/\d{3}-\d{7}-\d{7}/)?.[0];
      if (linkTextId) result.push(linkTextId);
    }
    return result;
  };

  const orderIdsFromText = (scope: Element): string[] => {
    const result: string[] = [];
    for (const element of Array.from(scope.querySelectorAll("span, bdi, p, div"))) {
      if (element.children.length > 0) continue;
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      const match = text.match(
        /^(?:(?:Amazon(?:\.com)?\s+)?order(?:\s*(?:number|id|#))?\s*:?\s*)?(\d{3}-\d{7}-\d{7})$/i,
      );
      if (match?.[1]) result.push(match[1]);
    }
    return result;
  };

  const productionItems = (scope: Element): RawAmazonItem[] => {
    const items = new Map<string, RawAmazonItem>();
    for (const link of Array.from(
      scope.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/dp/"], a[href*="/gp/product/"]',
      ),
    )) {
      const href = link.getAttribute("href");
      const titleText = link.textContent?.trim();
      if (!href || href.length > 2_048 || !titleText) continue;
      try {
        const url = new URL(href, "https://www.amazon.com");
        if (url.hostname !== "www.amazon.com" && url.hostname !== "amazon.com") continue;
        const asin = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Za-z0-9]{10})(?:[/?]|$)/)?.[1];
        if (!asin) continue;
        const container = link.closest(
          "[data-order-item], li, .a-fixed-left-grid-inner, .a-row",
        );
        const quantity = container?.textContent?.match(/(?:qty|quantity)\s*:?\s*(\d{1,3})/i)?.[1] ?? "1";
        const normalizedTitle = titleText.replace(/\s+/g, " ").trim();
        if (
          /^(?:buy it again|view (?:your )?item|write a (?:product )?review|return (?:this )?item|track package|product support)$/i.test(
            normalizedTitle,
          )
        ) {
          continue;
        }
        const key = asin.toUpperCase();
        const existing = items.get(key);
        if (existing) {
          if (!existing.title.includes(normalizedTitle)) existing.title.push(normalizedTitle);
          if (!existing.quantity.includes(quantity)) existing.quantity.push(quantity);
        } else {
          items.set(key, {
            title: [normalizedTitle],
            asin: [asin],
            quantity: [quantity],
          });
        }
      } catch {
        // Ignore malformed product navigation; an empty item set fails closed later.
      }
    }
    return Array.from(items.values());
  };

  const cards =
    syntheticRoots.length > 0
      ? Array.from(root.querySelectorAll<HTMLElement>("[data-order-card]"))
      : productionCards;
  const orders = cards.map((card) => {
    const syntheticItems = Array.from(
      card.querySelectorAll<HTMLElement>("[data-order-item]"),
    ).map(collectItem);
    return {
      orderId: [
        ...values(card, "[data-order-id]", ["data-order-id"], true),
        ...orderIdsFromLinks(card),
        ...orderIdsFromText(card),
      ],
      orderDate: [
        ...values(
          card,
          "[data-order-date]",
          ["datetime", "data-order-date"],
          true,
        ),
        ...labeledValues(card, /^ORDER\s+PLACED:?$/i),
      ],
      orderTotal: [
        ...values(card, "[data-order-total]", ["data-order-total"], true),
        ...labeledValues(card, /^(?:ORDER\s+)?TOTAL:?$/i),
      ],
      status: values(
        card,
        "[data-order-status], .order-status, .shipment-status, .delivery-status, .delivery-box__primary-text, .yohtmlc-shipment-status-primaryText, .shipment-top-row .a-color-success, .delivery-box .a-color-success",
        ["data-order-status"],
        true,
      ),
      items: syntheticItems.length > 0 ? syntheticItems : productionItems(card),
    };
  });

  const nextLinks = Array.from(
    root.querySelectorAll<HTMLAnchorElement>(
      "a[data-orders-next], li.a-last > a, a[rel=next]",
    ),
  )
    .filter((link) => link.getAttribute("aria-disabled") !== "true")
    .map((link) => link.getAttribute("href"))
    .filter((href): href is string => Boolean(href?.trim()));
  const nextPaths: string[] = [];
  for (const href of nextLinks) {
    try {
      const url = new URL(href, "https://www.amazon.com");
      const hostAllowed = url.hostname === "www.amazon.com" || url.hostname === "amazon.com";
      const pathAllowed =
        url.pathname === "/gp/your-account/order-history" ||
        url.pathname === "/gp/css/order-history" ||
        url.pathname === "/your-orders/orders";
      if (
        url.protocol !== "https:" ||
        !hostAllowed ||
        !pathAllowed ||
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" ||
        href.length > 2_048
      ) {
        return { kind: "unrecognized" };
      }
      nextPaths.push(`${url.pathname}${url.search}`);
    } catch {
      return { kind: "unrecognized" };
    }
  }
  const uniqueNextPaths = Array.from(new Set(nextPaths));
  if (uniqueNextPaths.length > 1) return { kind: "unrecognized" };

  return {
    kind: "orders_list",
    rootCount: syntheticRoots.length || 1,
    emptyMarker:
      root.querySelector("[data-amazon-orders-empty], .empty-orders, .your-orders-empty") !==
      null,
    nextPagePath: uniqueNextPaths[0] ?? null,
    orders,
  };
}

/**
 * Browser-callable collector for a single order page. It gathers only values
 * that can become an allowlisted response field.
 */
export function collectAmazonOrderDetail(
  documentRef: Document = document,
): RawAmazonOrderDetailCollection {
  const title = documentRef.title ?? "";
  if (
    documentRef.querySelector(
      '[data-amazon-page="challenge"], form[action*="/errors/validateCaptcha"], input[name="cvf_captcha_input"], #captchacharacters',
    ) !== null ||
    /(?:captcha|robot check|verify your identity)/i.test(title)
  ) {
    return { kind: "challenge" };
  }
  if (
    documentRef.querySelector(
      '[data-amazon-page="sign-in"], form[action*="/ap/signin"], input[name="email"][type="email"]',
    ) !== null ||
    /amazon\s+sign[ -]?in/i.test(title)
  ) {
    return { kind: "signed_out" };
  }

  const syntheticListCount = documentRef.querySelectorAll("[data-amazon-orders-list]").length;
  const productionListCandidates = Array.from(
    documentRef.querySelectorAll(
      '.order-card, .js-order-card, .a-box-group.order, .order-card__list, [data-component="orderCard"]',
    ),
  );
  const productionCandidateOrderIds = productionListCandidates.map((card) => {
    const identifiers: string[] = [
      ...((card.textContent ?? "").match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []),
    ];
    for (const link of card.querySelectorAll(
      'a[href*="orderID="], a[href*="orderId="]',
    )) {
      const href = link.getAttribute("href") ?? "";
      const rawIdentifier = href.match(/[?&]orderI[Dd]=([^&#]+)/)?.[1];
      if (rawIdentifier) {
        try {
          identifiers.push(decodeURIComponent(rawIdentifier));
        } catch {
          identifiers.push(rawIdentifier);
        }
      }
      identifiers.push(
        ...(href.match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []),
      );
    }
    return Array.from(new Set(identifiers));
  });
  const seenProductionOrderIds = new Set<string>();
  const productionListCount = productionCandidateOrderIds.filter((identifiers) => {
    if (identifiers.length !== 1 || seenProductionOrderIds.has(identifiers[0]!)) {
      return false;
    }
    seenProductionOrderIds.add(identifiers[0]!);
    return true;
  }).length;
  const roots = Array.from(
    documentRef.querySelectorAll<HTMLElement>(
      '[data-amazon-order-detail], #orderDetails, .order-details-container, [data-component="orderDetails"], [data-testid="order-details"]',
    ),
  );
  const listCount = syntheticListCount || productionListCount;
  if (listCount > 0 && roots.length === 0) return { kind: "orders_list" };
  if (listCount > 0 || roots.length === 0) return { kind: "unrecognized" };

  const uniqueRoots = roots.filter(
    (candidate, index) => !roots.some((other, otherIndex) => otherIndex < index && other.contains(candidate)),
  );
  if (uniqueRoots.length !== 1) return { kind: "unrecognized" };
  const root = uniqueRoots[0]!;

  const values = (
    scope: Element,
    selector: string,
    attributes: string[],
    includeText: boolean,
  ): string[] => {
    const nodes: Element[] = [];
    if (scope.matches(selector)) nodes.push(scope);
    nodes.push(...Array.from(scope.querySelectorAll(selector)));
    const result: string[] = [];
    for (const node of nodes) {
      for (const attribute of attributes) {
        const value = node.getAttribute(attribute);
        if (value?.trim()) result.push(value);
      }
      if (includeText && node.children.length === 0) {
        const value = node.textContent;
        if (value?.trim()) result.push(value);
      }
    }
    return result;
  };

  const collectItem = (element: Element): RawAmazonItem => ({
    title: values(element, "[data-item-title]", ["data-item-title"], true),
    asin: values(element, "[data-asin]", ["data-asin"], false),
    quantity: values(element, "[data-quantity]", ["data-quantity"], true),
  });

  const labeledValues = (scope: Element, expectedLabel: RegExp): string[] => {
    const result: string[] = [];
    for (const label of Array.from(scope.querySelectorAll("span, dt, th, div"))) {
      const text = (label.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!expectedLabel.test(text)) continue;
      const sibling =
        label.nextElementSibling ?? label.parentElement?.nextElementSibling ?? null;
      const value = sibling?.textContent;
      if (value?.trim()) result.push(value);
    }
    return result;
  };

  const orderIdsFromLinks = (scope: Element): string[] => {
    const result: string[] = [];
    for (const link of Array.from(
      scope.querySelectorAll<HTMLAnchorElement>(
        'a[href*="orderID="], a[href*="orderId="]',
      ),
    )) {
      const href = link.getAttribute("href");
      if (!href || href.length > 2_048) continue;
      try {
        const url = new URL(href, "https://www.amazon.com");
        if (url.hostname !== "www.amazon.com" && url.hostname !== "amazon.com") continue;
        const id = url.searchParams.get("orderID") ?? url.searchParams.get("orderId");
        if (id) result.push(id);
      } catch {
        // Required-field validation handles malformed/missing IDs.
      }
      const linkTextId = link.textContent?.match(/\d{3}-\d{7}-\d{7}/)?.[0];
      if (linkTextId) result.push(linkTextId);
    }
    return result;
  };

  const orderIdsFromText = (scope: Element): string[] => {
    const result: string[] = [];
    for (const element of Array.from(scope.querySelectorAll("span, bdi, p, div"))) {
      if (element.children.length > 0) continue;
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      const match = text.match(
        /^(?:(?:Amazon(?:\.com)?\s+)?order(?:\s*(?:number|id|#))?\s*:?\s*)?(\d{3}-\d{7}-\d{7})$/i,
      );
      if (match?.[1]) result.push(match[1]);
    }
    return result;
  };

  const productionItems = (scope: Element): RawAmazonItem[] => {
    const items = new Map<string, RawAmazonItem>();
    for (const link of Array.from(
      scope.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/dp/"], a[href*="/gp/product/"]',
      ),
    )) {
      const href = link.getAttribute("href");
      const titleText = link.textContent?.trim();
      if (!href || href.length > 2_048 || !titleText) continue;
      try {
        const url = new URL(href, "https://www.amazon.com");
        if (url.hostname !== "www.amazon.com" && url.hostname !== "amazon.com") continue;
        const asin = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Za-z0-9]{10})(?:[/?]|$)/)?.[1];
        if (!asin) continue;
        const container = link.closest(
          "[data-order-item], li, .a-fixed-left-grid-inner, .a-row",
        );
        const quantity = container?.textContent?.match(/(?:qty|quantity)\s*:?\s*(\d{1,3})/i)?.[1] ?? "1";
        const normalizedTitle = titleText.replace(/\s+/g, " ").trim();
        if (
          /^(?:buy it again|view (?:your )?item|write a (?:product )?review|return (?:this )?item|track package|product support)$/i.test(
            normalizedTitle,
          )
        ) {
          continue;
        }
        const key = asin.toUpperCase();
        const existing = items.get(key);
        if (existing) {
          if (!existing.title.includes(normalizedTitle)) existing.title.push(normalizedTitle);
          if (!existing.quantity.includes(quantity)) existing.quantity.push(quantity);
        } else {
          items.set(key, {
            title: [normalizedTitle],
            asin: [asin],
            quantity: [quantity],
          });
        }
      } catch {
        // Empty item sets are rejected by the strict parser.
      }
    }
    return Array.from(items.values());
  };

  const syntheticShipmentElements = Array.from(
    root.querySelectorAll<HTMLElement>("[data-shipment]"),
  );
  const shipmentElements =
    syntheticShipmentElements.length > 0
      ? syntheticShipmentElements
      : Array.from(
          root.querySelectorAll<HTMLElement>(
            '.shipment, .shipment-info, .shipment-details, .a-box.shipment, [data-component="shipment"], [data-testid="shipment"]',
          ),
        );
  const shipments = shipmentElements.map((shipment): RawAmazonShipment => {
    const syntheticItems = Array.from(
      shipment.querySelectorAll<HTMLElement>("[data-order-item]"),
    ).map(collectItem);
    return {
      status: values(
        shipment,
        "[data-shipment-status], .order-status, .shipment-status, .delivery-status, .delivery-box__primary-text, .yohtmlc-shipment-status-primaryText, .shipment-top-row .a-color-success, .delivery-box .a-color-success",
        ["data-shipment-status"],
        true,
      ),
      total: [
        ...values(
          shipment,
          "[data-shipment-total]",
          ["data-shipment-total"],
          true,
        ),
        ...labeledValues(shipment, /^SHIPMENT\s+TOTAL$/i),
      ],
      items: syntheticItems.length > 0 ? syntheticItems : productionItems(shipment),
    };
  });

  const syntheticBreakdownElements = Array.from(
    root.querySelectorAll<HTMLElement>("[data-price-breakdown]"),
  );
  if (syntheticBreakdownElements.length > 1) return { kind: "unrecognized" };
  const hasProductionBreakdown = Array.from(
    root.querySelectorAll("span, dt, th, div"),
  ).some((element) =>
    /^(?:ITEM\(S\) SUBTOTAL|ITEM SUBTOTAL|GRAND TOTAL)$/i.test(
      (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    ),
  );
  const breakdownElement = syntheticBreakdownElements[0] ?? (hasProductionBreakdown ? root : undefined);
  const priceBreakdown: RawAmazonPriceBreakdown | undefined = breakdownElement
    ? {
        itemSubtotal: values(
          breakdownElement,
          "[data-breakdown-subtotal]",
          ["data-breakdown-subtotal"],
          true,
        ).concat(labeledValues(breakdownElement, /^ITEM(?:\(S\))?\s+SUBTOTAL:?$/i)),
        shipping: values(
          breakdownElement,
          "[data-breakdown-shipping]",
          ["data-breakdown-shipping"],
          true,
        ).concat(labeledValues(breakdownElement, /^SHIPPING(?:\s*&\s*HANDLING)?:?$/i)),
        tax: values(
          breakdownElement,
          "[data-breakdown-tax]",
          ["data-breakdown-tax"],
          true,
        ).concat(labeledValues(breakdownElement, /^(?:ESTIMATED\s+)?TAX:?$/i)),
        discounts: values(
          breakdownElement,
          "[data-breakdown-discounts]",
          ["data-breakdown-discounts"],
          true,
        ).concat(labeledValues(breakdownElement, /^(?:PROMOTION(?:S)?|DISCOUNT(?:S)?):?$/i)),
        orderTotal: values(
          breakdownElement,
          "[data-breakdown-total]",
          ["data-breakdown-total"],
          true,
        ).concat(labeledValues(breakdownElement, /^(?:GRAND\s+TOTAL|ORDER\s+TOTAL):?$/i)),
      }
    : undefined;

  const order = {
    orderId: [
      ...values(root, "[data-order-id]", ["data-order-id"], true),
      ...orderIdsFromLinks(root),
      ...orderIdsFromText(root),
    ],
    orderDate: [
      ...values(
        root,
        "[data-order-date]",
        ["datetime", "data-order-date"],
        true,
      ),
      ...labeledValues(root, /^ORDER\s+PLACED:?$/i),
    ],
    orderTotal: [
      ...values(root, "[data-order-total]", ["data-order-total"], true),
      ...labeledValues(root, /^(?:ORDER|GRAND)\s+TOTAL:?$/i),
    ],
    shipments,
    ...(priceBreakdown ? { priceBreakdown } : {}),
  };

  return { kind: "order_detail", rootCount: uniqueRoots.length, order };
}

export function parseAmazonOrderList(
  collection: RawAmazonOrderListCollection,
): AmazonOrderSummary[] {
  assertExpectedPage(collection.kind, "orders_list");
  if (collection.kind !== "orders_list" || collection.rootCount !== 1) {
    throw new AmazonParseError("UNRECOGNIZED_LAYOUT");
  }
  if (collection.orders.length === 0) {
    if (collection.emptyMarker) return [];
    throw new AmazonParseError("UNRECOGNIZED_LAYOUT");
  }
  if (collection.emptyMarker) throw new AmazonParseError("CONFLICTING_FIELD");

  const orders = collection.orders.map((raw) => {
    const status = parseStatus(raw.status);
    return {
      orderId: parseOrderId(raw.orderId),
      orderDate: parseDateCandidates(raw.orderDate),
      orderTotal: parseAmountCandidates(raw.orderTotal),
      status: status.status,
      statusLabel: status.statusLabel,
      items: raw.items.map(parseItem),
    } satisfies AmazonOrderSummary;
  });

  const seen = new Set<string>();
  for (const order of orders) {
    if (seen.has(order.orderId)) throw new AmazonParseError("CONFLICTING_FIELD");
    seen.add(order.orderId);
  }
  return orders;
}

export function parseAmazonOrderListDocument(
  documentRef: Document = document,
): AmazonOrderSummary[] {
  return parseAmazonOrderList(collectAmazonOrderList(documentRef));
}

export function parseAmazonOrderDetail(
  collection: RawAmazonOrderDetailCollection,
): AmazonOrderDetail {
  assertExpectedPage(collection.kind, "order_detail");
  if (collection.kind !== "order_detail" || collection.rootCount !== 1) {
    throw new AmazonParseError("UNRECOGNIZED_LAYOUT");
  }
  if (collection.order.shipments.length === 0) {
    throw new AmazonParseError("UNRECOGNIZED_LAYOUT");
  }

  const orderTotal = parseAmountCandidates(collection.order.orderTotal);
  const result: AmazonOrderDetail = {
    orderId: parseOrderId(collection.order.orderId),
    orderDate: parseDateCandidates(collection.order.orderDate),
    orderTotal,
    shipments: collection.order.shipments.map(parseShipment),
  };

  if (collection.order.priceBreakdown) {
    result.priceBreakdown = parsePriceBreakdown(
      collection.order.priceBreakdown,
      orderTotal,
    );
  }
  return result;
}

export function parseAmazonOrderDetailDocument(
  documentRef: Document = document,
): AmazonOrderDetail {
  return parseAmazonOrderDetail(collectAmazonOrderDetail(documentRef));
}

export function sanitizeAmazonText(value: string, maxCodePoints: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, Math.max(0, maxCodePoints)).join("");
}

export interface ParseUsdOptions {
  requireCurrencyMarker?: boolean;
  allowNegative?: boolean;
}

/** Parses decimal currency text without IEEE-754 arithmetic. */
export function parseUsdCents(value: string, options: ParseUsdOptions = {}): number {
  let normalized = sanitizeAmazonText(value, 100)
    .replace(/[−﹣－]/gu, "-")
    .replace(
      /^(?:order total|total|item subtotal|shipping(?: & handling)?|estimated tax|tax|promotions?|discounts?|shipment total)\s*:?\s*/iu,
      "",
    )
    .trim();

  let parenthesized = false;
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    parenthesized = true;
    normalized = normalized.slice(1, -1).trim();
  }

  const match = normalized.match(
    /^(?<sign>-)?\s*(?:(?<prefix>US\$|\$|USD)\s*)?(?<whole>0|[1-9][\d,]*)(?:\.(?<fraction>\d{1,2}))?\s*(?<suffix>USD)?$/iu,
  );
  if (!match?.groups) throw new AmazonParseError("INVALID_FIELD");
  if (options.requireCurrencyMarker && !match.groups.prefix && !match.groups.suffix) {
    throw new AmazonParseError("INVALID_FIELD");
  }

  const wholeText = match.groups.whole!;
  if (
    (wholeText.includes(",") && !/^\d{1,3}(?:,\d{3})+$/.test(wholeText)) ||
    (!wholeText.includes(",") && !/^(?:0|[1-9]\d*)$/.test(wholeText))
  ) {
    throw new AmazonParseError("INVALID_FIELD");
  }
  const whole = Number(wholeText.replaceAll(",", ""));
  const fraction = (match.groups.fraction ?? "").padEnd(2, "0");
  let cents = whole * 100 + Number(fraction || "0");
  if (!Number.isSafeInteger(cents) || cents > MAX_USD_CENTS) {
    throw new AmazonParseError("INVALID_FIELD");
  }

  const negative = Boolean(match.groups.sign) || parenthesized;
  if (negative && cents !== 0) cents = -cents;
  if (cents < 0 && !options.allowNegative) {
    throw new AmazonParseError("INVALID_FIELD");
  }
  return cents;
}

export function usdAmountFromCents(cents: number): AmazonUsdAmount {
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_USD_CENTS) {
    throw new AmazonParseError("INVALID_FIELD");
  }
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return {
    currency: "USD",
    cents,
    decimal: `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`,
  };
}

/**
 * Finds exact/fuzzy transaction candidates using integer cents. Order totals,
 * individual shipment totals, and the sum of all shipment totals are eligible.
 */
export function matchAmazonOrders(
  orders: readonly AmazonOrder[],
  criteria: AmazonOrderMatchCriteria,
): AmazonOrderMatch[] {
  const targetCents = resolveCriteriaAmount(criteria);
  const targetDate = criteria.orderDate ? parseIsoDate(criteria.orderDate) : undefined;
  const window = criteria.dateWindowDays ?? 0;
  if (!Number.isInteger(window) || window < 0 || window > 365) {
    throw new AmazonParseError("INVALID_FIELD");
  }
  const query = criteria.itemQuery
    ? sanitizeAmazonText(criteria.itemQuery, AMAZON_TEXT_LIMITS.itemQuery).toLocaleLowerCase(
        "en-US",
      )
    : undefined;
  if (criteria.itemQuery !== undefined && !query) {
    throw new AmazonParseError("INVALID_FIELD");
  }
  const limit = criteria.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AmazonParseError("INVALID_FIELD");
  }

  const ranked: Array<AmazonOrderMatch & { sourceRank: number; amountDelta: number }> = [];
  for (const order of orders) {
    const dateDistanceDays = targetDate
      ? Math.abs(daysSinceEpoch(parseIsoDate(order.orderDate)) - daysSinceEpoch(targetDate))
      : undefined;
    if (dateDistanceDays !== undefined && dateDistanceDays > window) continue;

    if (query) {
      const titles = getOrderItems(order).map((item) => item.title.toLocaleLowerCase("en-US"));
      if (!titles.some((title) => title.includes(query))) continue;
    }

    const candidates = amountCandidates(order);
    const matching = candidates
      .filter((candidate) => candidate.cents === targetCents)
      .sort((left, right) => left.rank - right.rank || left.index - right.index);
    const winner = matching[0];
    if (!winner) continue;

    ranked.push({
      order,
      matchedAmount: usdAmountFromCents(winner.cents),
      matchedAmountSource: winner.source,
      ...(dateDistanceDays !== undefined ? { dateDistanceDays } : {}),
      sourceRank: winner.rank,
      amountDelta: 0,
    });
  }

  ranked.sort((left, right) => {
    const dateDifference = (left.dateDistanceDays ?? 0) - (right.dateDistanceDays ?? 0);
    if (dateDifference !== 0) return dateDifference;
    if (left.amountDelta !== right.amountDelta) return left.amountDelta - right.amountDelta;
    if (left.sourceRank !== right.sourceRank) return left.sourceRank - right.sourceRank;
    if (left.order.orderDate !== right.order.orderDate) {
      return right.order.orderDate.localeCompare(left.order.orderDate);
    }
    return left.order.orderId.localeCompare(right.order.orderId);
  });

  return ranked.slice(0, limit).map(({ sourceRank: _sourceRank, amountDelta: _delta, ...match }) => match);
}

function assertExpectedPage(actual: string, expected: "orders_list" | "order_detail"): void {
  if (actual === "signed_out") throw new AmazonParseError("SIGNED_OUT");
  if (actual === "challenge") throw new AmazonParseError("CHALLENGE");
  if (actual !== expected) throw new AmazonParseError("UNRECOGNIZED_LAYOUT");
}

function strictCandidate<T>(
  candidates: readonly string[],
  parse: (candidate: string) => T,
  key: (value: T) => string,
  required = true,
): T | undefined {
  const values: T[] = [];
  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    values.push(parse(candidate));
  }
  const unique = new Map<string, T>();
  for (const value of values) unique.set(key(value), value);
  if (unique.size === 0) {
    if (required) throw new AmazonParseError("MISSING_FIELD");
    return undefined;
  }
  if (unique.size !== 1) throw new AmazonParseError("CONFLICTING_FIELD");
  return unique.values().next().value;
}

function parseOrderId(candidates: readonly string[]): string {
  return strictCandidate(
    candidates,
    (candidate) => {
      const value = sanitizeAmazonText(candidate, 80)
        .replace(/^order(?:\s*(?:number|id|#))?\s*:?\s*/iu, "")
        .trim();
      if (!ORDER_ID_PATTERN.test(value)) throw new AmazonParseError("INVALID_FIELD");
      return value;
    },
    (value) => value,
  )!;
}

function parseDateCandidates(candidates: readonly string[]): string {
  return strictCandidate(candidates, parseAmazonDate, (value) => value)!;
}

function parseAmazonDate(candidate: string): string {
  const value = sanitizeAmazonText(candidate, 100)
    .replace(/^(?:ordered|order placed)(?:\s+on)?\s*:?\s*/iu, "")
    .trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    parseIsoDate(value);
    return value;
  }

  const match = value.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})$/iu,
  );
  if (!match) throw new AmazonParseError("INVALID_FIELD");
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const month = months.indexOf(match[1]!.toLocaleLowerCase("en-US")) + 1;
  const result = `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
  parseIsoDate(result);
  return result;
}

function parseIsoDate(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new AmazonParseError("INVALID_FIELD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100) throw new AmazonParseError("INVALID_FIELD");
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new AmazonParseError("INVALID_FIELD");
  }
  return date;
}

function parseAmountCandidates(
  candidates: readonly string[],
  allowNegative?: boolean,
  required?: true,
): AmazonUsdAmount;
function parseAmountCandidates(
  candidates: readonly string[],
  allowNegative: boolean,
  required: false,
): AmazonUsdAmount | undefined;
function parseAmountCandidates(
  candidates: readonly string[],
  allowNegative = false,
  required = true,
): AmazonUsdAmount | undefined {
  return strictCandidate(
    candidates,
    (candidate) =>
      usdAmountFromCents(
        parseUsdCents(candidate, { requireCurrencyMarker: true, allowNegative }),
      ),
    (amount) => String(amount.cents),
    required,
  );
}

function parseItem(raw: RawAmazonItem): AmazonOrderItem {
  const title = strictCandidate(
    raw.title,
    (candidate) => {
      const value = sanitizeAmazonText(candidate, AMAZON_TEXT_LIMITS.itemTitle);
      if (!value) throw new AmazonParseError("INVALID_FIELD");
      return value;
    },
    (value) => value,
  )!;
  const asin = strictCandidate(
    raw.asin,
    (candidate) => {
      const value = sanitizeAmazonText(candidate, 40)
        .replace(/^ASIN\s*:?\s*/iu, "")
        .toUpperCase();
      if (!ASIN_PATTERN.test(value)) throw new AmazonParseError("INVALID_FIELD");
      return value;
    },
    (value) => value,
  )!;
  const quantity = strictCandidate(
    raw.quantity,
    (candidate) => {
      const value = sanitizeAmazonText(candidate, 40).replace(
        /^(?:qty|quantity)\s*:?\s*/iu,
        "",
      );
      if (!/^[1-9]\d{0,2}$/.test(value)) throw new AmazonParseError("INVALID_FIELD");
      const parsed = Number(value);
      if (parsed > 999) throw new AmazonParseError("INVALID_FIELD");
      return parsed;
    },
    String,
  )!;
  return { title, asin, quantity };
}

function parseShipment(raw: RawAmazonShipment): AmazonShipment {
  if (raw.items.length === 0) throw new AmazonParseError("MISSING_FIELD");
  const status = parseStatus(raw.status);
  const total = parseAmountCandidates(raw.total, false, false);
  return {
    status: status.status,
    statusLabel: status.statusLabel,
    ...(total ? { total } : {}),
    items: raw.items.map(parseItem),
  };
}

function parseStatus(candidates: readonly string[]): {
  status: AmazonOrderStatus;
  statusLabel: string;
} {
  if (candidates.length === 0) return { status: "unknown", statusLabel: "Unknown" };
  const labels = Array.from(
    new Set(
      candidates
        .map((candidate) =>
          sanitizeAmazonText(candidate, AMAZON_TEXT_LIMITS.shipmentStatus),
        )
        .filter(Boolean),
    ),
  );
  if (labels.length === 0) return { status: "unknown", statusLabel: "Unknown" };
  const mapped = labels.map((statusLabel) => ({
    status: normalizeStatus(statusLabel),
    statusLabel,
  }));
  const statuses = new Set(mapped.map((entry) => entry.status));
  if (statuses.size !== 1) throw new AmazonParseError("CONFLICTING_FIELD");
  mapped.sort(
    (left, right) =>
      right.statusLabel.length - left.statusLabel.length ||
      left.statusLabel.localeCompare(right.statusLabel),
  );
  return mapped[0]!;
}

function normalizeStatus(label: string): AmazonOrderStatus {
  const normalized = label.toLocaleLowerCase("en-US");
  if (/\brefund(?:ed)?\b/u.test(normalized)) return "refunded";
  if (/\breturn(?:ed|ing)?\b/u.test(normalized)) return "returned";
  if (/\bcancell?ed\b/u.test(normalized)) return "cancelled";
  if (/\bdelivered\b/u.test(normalized)) return "delivered";
  if (/\b(?:shipped|out for delivery|in transit)\b/u.test(normalized)) return "shipped";
  if (/\b(?:processing|preparing|not yet shipped)\b/u.test(normalized)) return "processing";
  if (/\b(?:pending|order received)\b/u.test(normalized)) return "pending";
  return "unknown";
}

function parsePriceBreakdown(
  raw: RawAmazonPriceBreakdown,
  expectedOrderTotal: AmazonUsdAmount,
): AmazonPriceBreakdown {
  const itemSubtotal = parseAmountCandidates(raw.itemSubtotal, false, false);
  const shipping = parseAmountCandidates(raw.shipping, false, false);
  const tax = parseAmountCandidates(raw.tax, false, false);
  const discounts = parseAmountCandidates(raw.discounts, true, false);
  if (discounts && discounts.cents > 0) throw new AmazonParseError("INVALID_FIELD");
  const orderTotal = parseAmountCandidates(raw.orderTotal)!;
  if (orderTotal.cents !== expectedOrderTotal.cents) {
    throw new AmazonParseError("CONFLICTING_FIELD");
  }
  if (itemSubtotal && shipping && tax && discounts) {
    const calculated =
      itemSubtotal.cents + shipping.cents + tax.cents + discounts.cents;
    if (!Number.isSafeInteger(calculated) || calculated !== orderTotal.cents) {
      throw new AmazonParseError("CONFLICTING_FIELD");
    }
  }
  return {
    ...(itemSubtotal ? { itemSubtotal } : {}),
    ...(shipping ? { shipping } : {}),
    ...(tax ? { tax } : {}),
    ...(discounts ? { discounts } : {}),
    orderTotal,
  };
}

function resolveCriteriaAmount(criteria: AmazonOrderMatchCriteria): number {
  const fromDecimal =
    criteria.amountUsd !== undefined
      ? parseUsdCents(criteria.amountUsd, { allowNegative: false })
      : undefined;
  const fromCents = criteria.amountCents;
  if (
    fromCents !== undefined &&
    (!Number.isSafeInteger(fromCents) || fromCents < 0 || fromCents > MAX_USD_CENTS)
  ) {
    throw new AmazonParseError("INVALID_FIELD");
  }
  if (fromDecimal === undefined && fromCents === undefined) {
    throw new AmazonParseError("MISSING_FIELD");
  }
  if (fromDecimal !== undefined && fromCents !== undefined && fromDecimal !== fromCents) {
    throw new AmazonParseError("CONFLICTING_FIELD");
  }
  return fromDecimal ?? fromCents!;
}

function getOrderItems(order: AmazonOrder): AmazonOrderItem[] {
  return "shipments" in order
    ? order.shipments.flatMap((shipment) => shipment.items)
    : order.items;
}

function amountCandidates(order: AmazonOrder): Array<{
  cents: number;
  source: AmazonAmountMatchSource;
  rank: number;
  index: number;
}> {
  const result: Array<{
    cents: number;
    source: AmazonAmountMatchSource;
    rank: number;
    index: number;
  }> = [
    {
      cents: order.orderTotal.cents,
      source: { kind: "order_total" },
      rank: 0,
      index: -1,
    },
  ];
  if ("shipments" in order) {
    const shipmentTotals = order.shipments
      .map((shipment, index) => ({ total: shipment.total, index }))
      .filter(
        (entry): entry is { total: AmazonUsdAmount; index: number } =>
          entry.total !== undefined,
      );
    if (shipmentTotals.length === order.shipments.length) {
      const sum = shipmentTotals.reduce((total, shipment) => total + shipment.total.cents, 0);
      if (Number.isSafeInteger(sum)) {
        result.push({ cents: sum, source: { kind: "shipment_sum" }, rank: 1, index: -1 });
      }
    }
    for (const shipment of shipmentTotals) {
      result.push({
        cents: shipment.total.cents,
        source: { kind: "shipment_total", shipmentIndex: shipment.index },
        rank: 2,
        index: shipment.index,
      });
    }
  }
  return result;
}

function daysSinceEpoch(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}
