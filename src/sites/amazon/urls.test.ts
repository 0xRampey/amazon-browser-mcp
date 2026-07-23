import { describe, expect, it } from "vitest";

import {
  buildAmazonOrderDetailUrl,
  buildAmazonOrderHistoryUrl,
  buildAmazonPaginationUrl,
} from "./urls";

describe("fixed Amazon URLs", () => {
  it("constructs order URLs without accepting arbitrary destinations", () => {
    expect(buildAmazonOrderHistoryUrl("amazon.com")).toBe(
      "https://www.amazon.com/gp/your-account/order-history",
    );
    expect(buildAmazonOrderDetailUrl("amazon.com", "123-1234567-1234567")).toBe(
      "https://www.amazon.com/gp/your-account/order-details?orderID=123-1234567-1234567",
    );
  });

  it("rejects malformed IDs and marketplaces", () => {
    expect(() => buildAmazonOrderDetailUrl("amazon.com", "../cart")).toThrow();
    expect(() => buildAmazonOrderHistoryUrl("amazon.com.evil.example")).toThrow();
  });
});

describe("pagination URL", () => {
  it("accepts only known order-history paging parameters", () => {
    expect(
      buildAmazonPaginationUrl(
        "amazon.com",
        "/gp/your-account/order-history?orderFilter=year-2026&startIndex=10&ref_=next",
      ),
    ).toBe(
      "https://www.amazon.com/gp/your-account/order-history?orderFilter=year-2026&startIndex=10&ref_=next",
    );
  });

  it.each([
    "//evil.example/gp/your-account/order-history",
    "/gp/cart/view.html",
    "/gp/your-account/order-history?redirect=checkout",
    "/gp/your-account/order-history#secret",
  ])("rejects the page-provided target %s", (path) => {
    expect(() => buildAmazonPaginationUrl("amazon.com", path)).toThrow();
  });
});
