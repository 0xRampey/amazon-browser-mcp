import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp";

import {
  githubAuthorizationHandler,
  validateConnectorRegistration,
} from "./auth/github";
import { amazonBackendConfigurationError } from "./browser/amazon-backend";
import type { Env } from "./env";
import { DurableObjectAmazonGateway } from "./mcp/gateway";
import { createAmazonMcpServer } from "./mcp/server";

interface AuthProps {
  githubLogin: string;
  githubUserId: string;
  amazonRead: boolean;
}

class McpApiHandler extends WorkerEntrypoint<Env, AuthProps> {
  async fetch(request: Request): Promise<Response> {
    if (
      this.ctx.props.githubUserId !== this.env.ALLOWED_GITHUB_USER_ID ||
      this.ctx.props.amazonRead !== true
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const configurationError = amazonBackendConfigurationError(this.env);
    if (configurationError) {
      return new Response(configurationError, { status: 503 });
    }

    const server = createAmazonMcpServer(new DurableObjectAmazonGateway(this.env));
    return createMcpHandler(server)(request, this.env, this.ctx);
  }
}

export { AmazonBrowser } from "./sites/amazon/durable-object";

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientRegistrationCallback: validateConnectorRegistration,
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ["amazon.read"],
  allowPlainPKCE: false,
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler: githubAuthorizationHandler,
});
