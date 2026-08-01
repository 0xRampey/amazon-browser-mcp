import { describe, expect, it } from "vitest";

import { executeLocalAmazonOperation } from "../../browser/local-agent-executor";
import type { Env } from "../../env";
import { executeAmazonOperation } from "./service";
import {
  AmazonBrowser,
  executorForEnvironment,
} from "./durable-object";
import { AmazonOperationError } from "./operations";

function operationRequest(): Request {
  return new Request("https://amazon-browser.internal/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "session_status" }),
  });
}

describe("AmazonBrowser backend routing", () => {
  it("defaults to the local VPC executor and keeps Browserbase explicit", () => {
    expect(
      executorForEnvironment({
        AMAZON_BROWSER_BACKEND: undefined,
      } as Env),
    ).toBe(executeLocalAmazonOperation);
    expect(
      executorForEnvironment({
        AMAZON_BROWSER_BACKEND: "local",
      } as Env),
    ).toBe(executeLocalAmazonOperation);
    expect(
      executorForEnvironment({
        AMAZON_BROWSER_BACKEND: "browserbase",
      } as Env),
    ).toBe(executeAmazonOperation);
  });

  it("returns the fixed local-agent action without upstream diagnostics", async () => {
    const object = new AmazonBrowser(
      {} as DurableObjectState,
      {} as Env,
      async () => {
        throw new AmazonOperationError("LOCAL_AGENT_UNAVAILABLE");
      },
    );

    const response = await object.fetch(operationRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "LOCAL_AGENT_UNAVAILABLE",
        message:
          "The local Amazon browser agent is unavailable. Start the Mac agent and try again.",
        userActionRequired: true,
      },
    });
  });

  it("propagates the local runtime queue signal as a safe 429", async () => {
    const object = new AmazonBrowser(
      {} as DurableObjectState,
      {} as Env,
      async () => {
        throw new AmazonOperationError("QUEUE_FULL");
      },
    );

    const response = await object.fetch(operationRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "QUEUE_FULL",
        message: "Too many Amazon operations are pending.",
        userActionRequired: false,
      },
    });
  });

  it("fails closed for an invalid backend value", async () => {
    const execute = executorForEnvironment({
      AMAZON_BROWSER_BACKEND: "unexpected",
    } as Env);

    await expect(
      execute({} as Env, { action: "session_status" }),
    ).rejects.toMatchObject({ code: "TEMPORARY_FAILURE" });
  });
});
