import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  AMAZON_BROWSER: DurableObjectNamespace;
  LOCAL_BROWSER_AGENT: Fetcher;
  LOCAL_BROWSER_AGENT_SECRET: string;
  AMAZON_BROWSER_BACKEND?: string;
  BROWSERBASE_API_KEY: string;
  BROWSERBASE_REGION: "us-west-2" | "us-east-1" | "eu-central-1" | "ap-southeast-1";
  AMAZON_CONTEXT_ID: string;
  AMAZON_MARKETPLACE: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USER_ID: string;
}
