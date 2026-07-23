import type { Env } from "../env";
import { assertSecret } from "../../scripts/local-browser-agent/auth";

export type AmazonBrowserBackend = "local" | "browserbase";

/**
 * Local is the production default. Browserbase remains available only as an
 * explicitly selected hosted fallback.
 */
export function resolveAmazonBrowserBackend(
  value: string | undefined,
): AmazonBrowserBackend | undefined {
  if (value === undefined) return "local";
  if (value === "local" || value === "browserbase") return value;
  return undefined;
}

export function amazonBackendConfigurationError(
  env: Pick<
    Env,
    | "AMAZON_BROWSER_BACKEND"
    | "LOCAL_BROWSER_AGENT"
    | "LOCAL_BROWSER_AGENT_SECRET"
    | "BROWSERBASE_API_KEY"
    | "AMAZON_CONTEXT_ID"
  >,
): string | undefined {
  const backend = resolveAmazonBrowserBackend(env.AMAZON_BROWSER_BACKEND);
  if (!backend) return "AMAZON_BROWSER_BACKEND is invalid.";

  if (backend === "browserbase") {
    if (!env.BROWSERBASE_API_KEY) return "BROWSERBASE_API_KEY is not configured.";
    if (!env.AMAZON_CONTEXT_ID) return "AMAZON_CONTEXT_ID is not configured.";
    return undefined;
  }

  if (!env.LOCAL_BROWSER_AGENT || typeof env.LOCAL_BROWSER_AGENT.fetch !== "function") {
    return "LOCAL_BROWSER_AGENT is not configured.";
  }
  try {
    assertSecret(env.LOCAL_BROWSER_AGENT_SECRET);
  } catch {
    return "LOCAL_BROWSER_AGENT_SECRET is not configured correctly.";
  }
  return undefined;
}
