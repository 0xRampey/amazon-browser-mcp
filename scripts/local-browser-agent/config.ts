import { chmod, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { normalizeAmazonMarketplace } from "../../src/browser/request-guard";
import { assertSecret } from "./auth";

const DEFAULT_PORT = 43_218;
const MIN_UNPRIVILEGED_PORT = 1_024;

export interface LocalAgentConfig {
  marketplace: string;
  port: number;
  profileDirectory: string;
  secret?: string;
}

export function readLocalAgentConfig(
  environment: Record<string, string | undefined> = process.env,
  requireSecret = true,
): LocalAgentConfig {
  const marketplace = normalizeAmazonMarketplace(
    environment.AMAZON_MARKETPLACE ?? "www.amazon.com",
  );
  if (!marketplace) throw new TypeError("The Amazon marketplace is not supported.");

  const port = parsePort(environment.LOCAL_BROWSER_AGENT_PORT);
  const requestedProfile =
    environment.AMAZON_BROWSER_PROFILE_DIR ??
    resolve(homedir(), ".amazon-browser-mcp", "chrome-profile");
  if (!isAbsolute(requestedProfile)) {
    throw new TypeError("AMAZON_BROWSER_PROFILE_DIR must be an absolute path.");
  }

  const secret = environment.LOCAL_BROWSER_AGENT_SECRET;
  if (requireSecret) {
    if (secret === undefined) {
      throw new TypeError("LOCAL_BROWSER_AGENT_SECRET is required.");
    }
    assertSecret(secret);
  } else if (secret !== undefined) {
    assertSecret(secret);
  }

  return {
    marketplace,
    port,
    profileDirectory: resolve(requestedProfile),
    ...(secret === undefined ? {} : { secret }),
  };
}

export async function prepareProfileDirectory(requestedPath: string): Promise<string> {
  const resolved = resolve(requestedPath);
  assertDedicatedProfilePath(resolved);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  await chmod(resolved, 0o700);
  const canonical = await realpath(resolved);
  assertDedicatedProfilePath(canonical);
  return canonical;
}

export function assertDedicatedProfilePath(candidate: string): void {
  const resolved = resolve(candidate);
  const home = resolve(homedir());
  if (resolved === "/" || resolved === home) {
    throw new TypeError("The automation profile must use a dedicated subdirectory.");
  }

  const protectedRoots = [
    resolve(home, "Library", "Application Support", "Google", "Chrome"),
    resolve(home, "Library", "Application Support", "Chromium"),
    resolve(home, "Library", "Application Support", "Microsoft Edge"),
    resolve(home, ".config", "google-chrome"),
    resolve(home, ".config", "chromium"),
    resolve(home, ".config", "microsoft-edge"),
    ...(process.env.LOCALAPPDATA
      ? [
          resolve(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data"),
          resolve(process.env.LOCALAPPDATA, "Chromium", "User Data"),
          resolve(process.env.LOCALAPPDATA, "Microsoft", "Edge", "User Data"),
        ]
      : []),
  ];

  if (protectedRoots.some((root) => isSameOrDescendant(resolved, root))) {
    throw new TypeError("The daily browser profile cannot be used for automation.");
  }
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d{4,5}$/.test(value)) {
    throw new TypeError("LOCAL_BROWSER_AGENT_PORT must be an unprivileged TCP port.");
  }
  const port = Number(value);
  if (
    !Number.isSafeInteger(port) ||
    port < MIN_UNPRIVILEGED_PORT ||
    port > 65_535
  ) {
    throw new TypeError("LOCAL_BROWSER_AGENT_PORT must be an unprivileged TCP port.");
  }
  return port;
}
