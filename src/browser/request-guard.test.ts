import { describe, expect, it } from "vitest";

import {
  evaluateAmazonNavigationTarget,
  evaluateAmazonRequest,
  isAmazonAuthenticationUrl,
  normalizeAmazonMarketplace,
} from "./request-guard";

const MARKETPLACE = "amazon.com";

function request(
  url: string,
  overrides: Partial<Parameters<typeof evaluateAmazonRequest>[0]> = {},
) {
  return evaluateAmazonRequest(
    {
      url,
      method: "GET",
      resourceType: "document",
      isNavigationRequest: true,
      ...overrides,
    },
    MARKETPLACE,
  );
}

describe("Amazon top-level navigation guard", () => {
  it.each([
    "https://www.amazon.com/gp/css/order-history?ref_=nav_orders_first",
    "https://amazon.com/gp/your-account/order-history",
    "https://www.amazon.com/your-orders/orders?timeFilter=year-2026",
    "https://www.amazon.com/gp/your-account/order-details?orderID=123-1234567-1234567",
    "https://www.amazon.com/your-orders/order-details/123",
    "https://www.amazon.com/gp/css/summary/print.html?orderID=123",
    "https://www.amazon.com/ap/signin?openid.return_to=%2Fgp%2Fcss%2Forder-history",
    "https://www.amazon.com/ap/cvf/request?arb=challenge",
    "https://www.amazon.com/errors/validateCaptcha",
  ])("allows the fixed order/auth destination %s", (url) => {
    expect(request(url)).toEqual({ allow: true, reason: "allowed" });
  });

  it.each([
    "https://www.amazon.com/",
    "https://www.amazon.com/gp/bestsellers",
    "https://www.amazon.com/gp/your-account",
    "https://www.amazon.com/s?k=laptop",
  ])("denies unrelated marketplace navigation %s", (url) => {
    expect(request(url)).toEqual({ allow: false, reason: "unapproved_navigation" });
  });

  it("validates a redirect destination independently from its allowed source", () => {
    const allowedSource = evaluateAmazonNavigationTarget(
      "https://www.amazon.com/gp/css/order-history",
      MARKETPLACE,
    );
    const maliciousRedirect = evaluateAmazonNavigationTarget(
      "https://www.amazon.com/gp/cart/view.html",
      MARKETPLACE,
    );
    const offsiteRedirect = evaluateAmazonNavigationTarget(
      "https://example.com/gp/css/order-history",
      MARKETPLACE,
    );

    expect(allowedSource.allow).toBe(true);
    expect(maliciousRedirect).toEqual({ allow: false, reason: "blocked_path" });
    expect(offsiteRedirect).toEqual({ allow: false, reason: "unapproved_host" });
  });
});

describe("read-only request policy", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE"])(
    "blocks the %s method even on an allowed order URL",
    (method) => {
      expect(
        request("https://www.amazon.com/gp/css/order-history", { method }),
      ).toEqual({ allow: false, reason: "unsafe_method" });
    },
  );

  it.each(["GET", "HEAD", "OPTIONS"])("allows safe %s order requests", (method) => {
    expect(request("https://www.amazon.com/gp/css/order-history", { method }).allow).toBe(
      true,
    );
  });

  it.each(["websocket", "eventsource", "image", "media", "font"])(
    "blocks %s resources before host/path handling",
    (resourceType) => {
      expect(
        request("https://www.amazon.com/gp/css/order-history", {
          resourceType,
          isNavigationRequest: false,
        }),
      ).toEqual({ allow: false, reason: "blocked_resource_type" });
    },
  );

  it.each([
    "/gp/cart/view.html",
    "/checkout/p/p-123",
    "/gp/buy/spc/handlers/display.html",
    "/your-orders/order-cancel",
    "/spr/returns/label/123",
    "/review/create-review",
    "/hz/wishlist/ls",
    "/gp/css/homepage.html/settings",
    "/gp/your-account/address",
    "/gp/flex/sign-out.html",
  ])("blocks sensitive operation path %s", (path) => {
    expect(request(`https://www.amazon.com${path}`)).toEqual({
      allow: false,
      reason: "blocked_path",
    });
  });

  it("blocks dangerous operations hidden in query strings or encoding", () => {
    expect(
      request("https://www.amazon.com/gp/css/order-history?next=%2Fcheckout%2Fplace-order"),
    ).toEqual({ allow: false, reason: "blocked_path" });
    expect(request("https://www.amazon.com/gp/%2563art/view.html")).toEqual({
      allow: false,
      reason: "blocked_path",
    });
    expect(request("https://www.amazon.com/gp%255c%2563art/view.html")).toEqual({
      allow: false,
      reason: "blocked_path",
    });
  });
});

describe("host and protocol policy", () => {
  it.each([
    "https://amazon.com.evil.example/gp/css/order-history",
    "https://www.amazon.com.evil.example/gp/css/order-history",
    "https://evilamazon.com/gp/css/order-history",
    "https://amazon.co.uk/gp/css/order-history",
  ])("rejects unapproved or cross-marketplace host %s", (url) => {
    expect(request(url)).toEqual({ allow: false, reason: "unapproved_host" });
  });

  it.each([
    "http://www.amazon.com/gp/css/order-history",
    "https://user@www.amazon.com/gp/css/order-history",
    "https://www.amazon.com:444/gp/css/order-history",
  ])("rejects insecure URL shape %s", (url) => {
    expect(request(url)).toEqual({ allow: false, reason: "insecure_url" });
  });

  it("blocks every subresource, including same-origin and approved Amazon asset hosts", () => {
    const script = request("https://m.media-amazon.com/assets/orders.js", {
      resourceType: "script",
      isNavigationRequest: false,
    });
    const stylesheet = request("https://images-na.ssl-images-amazon.com/orders.css", {
      resourceType: "stylesheet",
      isNavigationRequest: false,
    });
    const assetFetch = request("https://m.media-amazon.com/api/customer", {
      resourceType: "fetch",
      isNavigationRequest: false,
    });
    const assetNavigation = request("https://m.media-amazon.com/gp/css/order-history", {
      resourceType: "document",
      isNavigationRequest: true,
    });

    const sameOriginFetch = request("https://www.amazon.com/gp/css/order-history/data", {
      resourceType: "fetch",
      isNavigationRequest: false,
    });

    expect(script).toEqual({ allow: false, reason: "unapproved_asset_request" });
    expect(stylesheet).toEqual({ allow: false, reason: "unapproved_asset_request" });
    expect(assetFetch).toEqual({ allow: false, reason: "unapproved_asset_request" });
    expect(assetNavigation).toEqual({ allow: false, reason: "unapproved_navigation" });
    expect(sameOriginFetch).toEqual({ allow: false, reason: "unapproved_subresource" });
  });
});

describe("marketplace and authentication helpers", () => {
  it("normalizes only a known marketplace", () => {
    expect(normalizeAmazonMarketplace("amazon.com")).toBe("www.amazon.com");
    expect(normalizeAmazonMarketplace("WWW.AMAZON.CO.UK.")).toBe("www.amazon.co.uk");
    expect(normalizeAmazonMarketplace("amazon.com.evil.example")).toBeUndefined();
  });

  it("detects only fixed authentication/challenge URLs on the configured marketplace", () => {
    expect(isAmazonAuthenticationUrl("https://www.amazon.com/ap/signin", MARKETPLACE)).toBe(
      true,
    );
    expect(
      isAmazonAuthenticationUrl("https://www.amazon.com/errors/validateCaptcha", MARKETPLACE),
    ).toBe(true);
    expect(isAmazonAuthenticationUrl("https://www.amazon.com/ap/profile", MARKETPLACE)).toBe(
      false,
    );
    expect(isAmazonAuthenticationUrl("https://evil.example/ap/signin", MARKETPLACE)).toBe(
      false,
    );
  });
});
