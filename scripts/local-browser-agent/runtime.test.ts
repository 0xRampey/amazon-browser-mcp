import type { BrowserContext, Page, Route } from "playwright-core";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildLoginLaunchOptions,
  buildProductionLaunchOptions,
  createReadOnlyPage,
  evaluateLoginSetupRequest,
  purgeStoredPasswordData,
} from "./runtime";

describe("local production browser hardening", () => {
  it("uses a headless dedicated Chrome context with scripts, workers, and downloads disabled", () => {
    const options = buildProductionLaunchOptions();
    expect(options).toMatchObject({
      acceptDownloads: false,
      chromiumSandbox: true,
      headless: true,
      javaScriptEnabled: false,
      serviceWorkers: "block",
      viewport: { width: 1_440, height: 1_000 },
    });
    expect(options).not.toHaveProperty("channel");
    expect(options.args).toContain("--disable-save-password-bubble");
  });

  it("keeps only the login command headful and interactive", () => {
    const options = buildLoginLaunchOptions();
    expect(options).toMatchObject({
      acceptDownloads: false,
      chromiumSandbox: true,
      headless: false,
      javaScriptEnabled: true,
      serviceWorkers: "block",
      viewport: null,
    });
    expect(options).not.toHaveProperty("channel");
  });

  it("installs CDP and route defenses before production navigation", async () => {
    const send = vi.fn(async () => undefined);
    let routeHandler: ((route: Route) => Promise<void>) | undefined;
    const handlers = new Map<string, (...arguments_: never[]) => void>();
    const page = {
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      route: vi.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
      on: vi.fn((name, handler) => {
        handlers.set(name, handler);
      }),
    };
    const context = {
      newPage: vi.fn(async () => page),
      newCDPSession: vi.fn(async () => ({ send })),
    };

    await expect(
      createReadOnlyPage(
        context as unknown as BrowserContext,
        "www.amazon.com",
      ),
    ).resolves.toBe(page as unknown as Page);
    expect(send).toHaveBeenCalledWith("Network.setBypassServiceWorker", {
      bypass: true,
    });
    expect(send).toHaveBeenCalledWith("Network.setCacheDisabled", {
      cacheDisabled: true,
    });
    expect(send).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
      behavior: "deny",
    });
    expect(routeHandler).toBeTypeOf("function");
    expect(handlers.has("popup")).toBe(true);
    expect(handlers.has("download")).toBe(true);

    const continue_ = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const request = {
      url: () => "https://www.amazon.com/gp/css/order-history",
      method: () => "GET",
      resourceType: () => "document",
      isNavigationRequest: () => true,
    };
    await routeHandler!({
      request: () => request,
      continue: continue_,
      abort,
    } as unknown as Route);
    expect(continue_).toHaveBeenCalledOnce();

    request.method = () => "POST";
    await routeHandler!({
      request: () => request,
      continue: continue_,
      abort,
    } as unknown as Route);
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
  });
});

describe("bounded interactive login policy", () => {
  const base = {
    resourceType: "document",
    isNavigationRequest: true,
  };

  it("allows only fixed Amazon order/auth navigation and auth POSTs", () => {
    expect(
      evaluateLoginSetupRequest(
        {
          ...base,
          url: "https://www.amazon.com/gp/css/order-history",
          method: "GET",
        },
        "www.amazon.com",
      ),
    ).toBe(true);
    expect(
      evaluateLoginSetupRequest(
        {
          url: "https://opfcaptcha.amazon.com/captcha/script.js",
          method: "GET",
          resourceType: "script",
          isNavigationRequest: false,
        },
        "www.amazon.com",
      ),
    ).toBe(true);
    expect(
      evaluateLoginSetupRequest(
        {
          ...base,
          url: "https://www.amazon.com/ap/signin",
          method: "POST",
        },
        "www.amazon.com",
      ),
    ).toBe(true);
    expect(
      evaluateLoginSetupRequest(
        {
          ...base,
          url: "https://www.amazon.com/ap/mfa",
          method: "POST",
        },
        "www.amazon.com",
      ),
    ).toBe(true);
  });

  it("blocks shopping, offsite, insecure, and persistent-channel requests", () => {
    for (const request of [
      {
        ...base,
        url: "https://www.amazon.com/gp/cart/view.html",
        method: "GET",
      },
      {
        ...base,
        url: "https://example.com/gp/css/order-history",
        method: "GET",
      },
      {
        ...base,
        url: "http://www.amazon.com/gp/css/order-history",
        method: "GET",
      },
      {
        url: "https://www.amazon.com/ap/signin",
        method: "GET",
        resourceType: "websocket",
        isNavigationRequest: false,
      },
      {
        url: "https://www.amazon.com/gp/css/order-history",
        method: "POST",
        resourceType: "fetch",
        isNavigationRequest: false,
      },
      {
        url: "https://www.amazon.com/gp/cart/add.html?asin=B0TEST0001",
        method: "GET",
        resourceType: "fetch",
        isNavigationRequest: false,
      },
      {
        url: "https://images-na.ssl-images-amazon.com/assets/login.js?next=%2Fcheckout",
        method: "GET",
        resourceType: "script",
        isNavigationRequest: false,
      },
    ]) {
      expect(evaluateLoginSetupRequest(request, "www.amazon.com")).toBe(false);
    }
  });

  it("allows only safe Amazon-owned login subresources", () => {
    expect(
      evaluateLoginSetupRequest(
        {
          url: "https://m.media-amazon.com/images/login.js",
          method: "GET",
          resourceType: "script",
          isNavigationRequest: false,
        },
        "www.amazon.com",
      ),
    ).toBe(true);
    expect(
      evaluateLoginSetupRequest(
        {
          url: "https://tracker.example/login.js",
          method: "GET",
          resourceType: "script",
          isNavigationRequest: false,
        },
        "www.amazon.com",
      ),
    ).toBe(false);
  });
});

describe("dedicated profile password-store purge", () => {
  it("removes Chrome Login Data files without touching session storage", async () => {
    const profile = await mkdtemp(join(tmpdir(), "amazon-browser-profile-"));
    const defaultProfile = join(profile, "Default");
    await mkdir(defaultProfile);
    await Promise.all([
      writeFile(join(defaultProfile, "Login Data"), "fictional-password-db"),
      writeFile(join(defaultProfile, "Login Data-journal"), "fictional-journal"),
      writeFile(join(defaultProfile, "Login Data-wal"), "fictional-wal"),
      writeFile(join(defaultProfile, "Login Data-shm"), "fictional-shm"),
      writeFile(
        join(defaultProfile, "Login Data For Account"),
        "fictional-account-password-db",
      ),
      writeFile(
        join(defaultProfile, "Login Data For Account-journal"),
        "fictional-account-journal",
      ),
      writeFile(
        join(defaultProfile, "Login Data For Account-wal"),
        "fictional-account-wal",
      ),
      writeFile(
        join(defaultProfile, "Login Data For Account-shm"),
        "fictional-account-shm",
      ),
      writeFile(join(defaultProfile, "Cookies"), "fictional-session-db"),
    ]);

    await purgeStoredPasswordData(profile);

    await expect(readFile(join(defaultProfile, "Login Data"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(defaultProfile, "Login Data-journal")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(defaultProfile, "Login Data-wal"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(defaultProfile, "Login Data-shm"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      await expect(
        readFile(join(defaultProfile, `Login Data For Account${suffix}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(join(defaultProfile, "Cookies"), "utf8")).resolves.toBe(
      "fictional-session-db",
    );
  });
});
