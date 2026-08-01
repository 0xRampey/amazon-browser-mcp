import type { BrowserContext, Page, Route } from "playwright-core";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildLoginLaunchOptions,
  buildProductionLaunchOptions,
  createReadOnlyPage,
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
      chromiumSandbox: true,
      headless: false,
      javaScriptEnabled: true,
      viewport: null,
    });
    expect(options).not.toHaveProperty("channel");
    expect(options).not.toHaveProperty("acceptDownloads");
    expect(options).not.toHaveProperty("serviceWorkers");
    expect(options.args).toEqual([
      "--disable-save-password-bubble",
      "--no-default-browser-check",
      "--no-first-run",
    ]);
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
