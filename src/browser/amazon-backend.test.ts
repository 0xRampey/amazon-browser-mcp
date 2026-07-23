import { describe, expect, it } from "vitest";

import type { Env } from "../env";
import {
  amazonBackendConfigurationError,
  resolveAmazonBrowserBackend,
} from "./amazon-backend";

const SECRET = "local-agent-test-secret-with-at-least-32-bytes";
const fetcher = {
  fetch: async () => new Response(),
} as unknown as Fetcher;

function environment(overrides: Partial<Env> = {}): Env {
  return {
    AMAZON_BROWSER_BACKEND: "local",
    LOCAL_BROWSER_AGENT: fetcher,
    LOCAL_BROWSER_AGENT_SECRET: SECRET,
    BROWSERBASE_API_KEY: "bb_live_test",
    AMAZON_CONTEXT_ID: "context-test",
    ...overrides,
  } as Env;
}

describe("Amazon browser backend configuration", () => {
  it("defaults to the local backend", () => {
    expect(resolveAmazonBrowserBackend(undefined)).toBe("local");
    expect(
      amazonBackendConfigurationError(
        environment({ AMAZON_BROWSER_BACKEND: undefined }),
      ),
    ).toBeUndefined();
  });

  it("requires the VPC binding and a valid shared secret for local mode", () => {
    expect(
      amazonBackendConfigurationError(
        environment({ LOCAL_BROWSER_AGENT: undefined as unknown as Fetcher }),
      ),
    ).toBe("LOCAL_BROWSER_AGENT is not configured.");
    expect(
      amazonBackendConfigurationError(
        environment({ LOCAL_BROWSER_AGENT_SECRET: "short" }),
      ),
    ).toBe("LOCAL_BROWSER_AGENT_SECRET is not configured correctly.");
  });

  it("requires only Browserbase credentials in explicit fallback mode", () => {
    expect(
      amazonBackendConfigurationError(
        environment({
          AMAZON_BROWSER_BACKEND: "browserbase",
          LOCAL_BROWSER_AGENT: undefined as unknown as Fetcher,
          LOCAL_BROWSER_AGENT_SECRET: "",
        }),
      ),
    ).toBeUndefined();
    expect(
      amazonBackendConfigurationError(
        environment({
          AMAZON_BROWSER_BACKEND: "browserbase",
          BROWSERBASE_API_KEY: "",
        }),
      ),
    ).toBe("BROWSERBASE_API_KEY is not configured.");
    expect(
      amazonBackendConfigurationError(
        environment({
          AMAZON_BROWSER_BACKEND: "browserbase",
          AMAZON_CONTEXT_ID: "",
        }),
      ),
    ).toBe("AMAZON_CONTEXT_ID is not configured.");
  });

  it("rejects misspelled backend names instead of silently changing routing", () => {
    expect(resolveAmazonBrowserBackend("browser-base")).toBeUndefined();
    expect(
      amazonBackendConfigurationError(
        environment({ AMAZON_BROWSER_BACKEND: "browser-base" }),
      ),
    ).toBe("AMAZON_BROWSER_BACKEND is invalid.");
  });
});
