import type { Browser } from "@cloudflare/puppeteer";
import { describe, expect, it, vi } from "vitest";

import { createGuardedPage } from "./service";

describe("Amazon browser page hardening", () => {
  it("closes inherited pages and disables scripts, downloads, workers, and cache before use", async () => {
    const calls: string[] = [];
    const inheritedPage = {
      close: vi.fn(async () => {
        calls.push("close-inherited");
      }),
    };
    const send = vi.fn(async (method: string) => {
      calls.push(method);
    });
    const page = {
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      setJavaScriptEnabled: vi.fn(async (enabled: boolean) => {
        calls.push(`javascript:${enabled}`);
      }),
      createCDPSession: vi.fn(async () => ({ send })),
      setRequestInterception: vi.fn(async (enabled: boolean) => {
        calls.push(`interception:${enabled}`);
      }),
      on: vi.fn(),
    };
    const browser = {
      pages: vi.fn(async () => [inheritedPage]),
      newPage: vi.fn(async () => {
        calls.push("new-page");
        return page;
      }),
    };

    await expect(
      createGuardedPage(browser as unknown as Browser, "www.amazon.com"),
    ).resolves.toBe(page);

    expect(calls.indexOf("close-inherited")).toBeLessThan(calls.indexOf("new-page"));
    expect(page.setJavaScriptEnabled).toHaveBeenCalledWith(false);
    expect(send).toHaveBeenCalledWith("Network.setBypassServiceWorker", { bypass: true });
    expect(send).toHaveBeenCalledWith("Network.setCacheDisabled", { cacheDisabled: true });
    expect(send).toHaveBeenCalledWith("Browser.setDownloadBehavior", { behavior: "deny" });
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
  });
});
