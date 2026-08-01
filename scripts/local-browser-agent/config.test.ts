import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertDedicatedProfilePath,
  prepareProfileDirectory,
  readLocalAgentConfig,
} from "./config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("local browser agent configuration", () => {
  it("uses a fixed marketplace, unprivileged port, and absolute dedicated profile", () => {
    const config = readLocalAgentConfig({
      AMAZON_MARKETPLACE: "amazon.com",
      AMAZON_BROWSER_PROFILE_DIR: "/tmp/amazon-test-profile",
      LOCAL_BROWSER_AGENT_PORT: "43218",
      LOCAL_BROWSER_AGENT_SECRET: "x".repeat(64),
    });
    expect(config).toEqual({
      marketplace: "www.amazon.com",
      port: 43_218,
      profileDirectory: "/tmp/amazon-test-profile",
      secret: "x".repeat(64),
    });
  });

  it("rejects relative, daily-driver, unsupported, privileged, and secretless config", () => {
    expect(() =>
      readLocalAgentConfig({
        AMAZON_BROWSER_PROFILE_DIR: "relative/profile",
        LOCAL_BROWSER_AGENT_SECRET: "x".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      assertDedicatedProfilePath(
        resolve(homedir(), "Library", "Application Support", "Google", "Chrome"),
      ),
    ).toThrow();
    expect(() =>
      readLocalAgentConfig({
        AMAZON_MARKETPLACE: "amazon.com.evil.example",
        AMAZON_BROWSER_PROFILE_DIR: "/tmp/amazon-test-profile",
        LOCAL_BROWSER_AGENT_SECRET: "x".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      readLocalAgentConfig({
        AMAZON_BROWSER_PROFILE_DIR: "/tmp/amazon-test-profile",
        LOCAL_BROWSER_AGENT_PORT: "443",
        LOCAL_BROWSER_AGENT_SECRET: "x".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      readLocalAgentConfig({
        AMAZON_BROWSER_PROFILE_DIR: "/tmp/amazon-test-profile",
      }),
    ).toThrow();
  });

  it("creates the profile directory with owner-only permissions", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "amazon-browser-agent-"));
    temporaryDirectories.push(parent);
    const profile = await prepareProfileDirectory(resolve(parent, "profile"));
    const metadata = await stat(profile);
    expect(metadata.mode & 0o777).toBe(0o700);
  });
});
