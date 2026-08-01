#!/usr/bin/env bun

import { prepareProfileDirectory, readLocalAgentConfig } from "./local-browser-agent/config";
import { LocalAmazonRuntime, runHeadfulLogin } from "./local-browser-agent/runtime";
import { createLocalAgentHandler } from "./local-browser-agent/server";

export type LocalAgentCommand = "login" | "serve" | "help";

export function parseLocalAgentCommand(arguments_: readonly string[]): LocalAgentCommand {
  if (
    arguments_.length === 0 ||
    (arguments_.length === 1 &&
      (arguments_[0] === "--help" || arguments_[0] === "-h" || arguments_[0] === "help"))
  ) {
    return "help";
  }
  if (arguments_.length === 1 && arguments_[0] === "login") return "login";
  if (arguments_.length === 1 && arguments_[0] === "serve") return "serve";
  throw new TypeError("Unsupported local browser agent command.");
}

async function main(): Promise<void> {
  process.umask(0o077);
  const command = parseLocalAgentCommand(process.argv.slice(2));
  if (command === "help") {
    printUsage();
    return;
  }

  if (command === "login") {
    const config = readLocalAgentConfig(process.env, false);
    const profileDirectory = await prepareProfileDirectory(config.profileDirectory);
    console.log(
      "A dedicated Amazon login window is opening. Sign in manually, do not save the password, then close the window.",
    );
    await runHeadfulLogin(profileDirectory, config.marketplace);
    console.log("The dedicated Amazon login window is closed.");
    return;
  }

  const config = readLocalAgentConfig(process.env, true);
  const secret = config.secret;
  if (!secret) throw new TypeError("LOCAL_BROWSER_AGENT_SECRET is required.");
  const profileDirectory = await prepareProfileDirectory(config.profileDirectory);
  const runtime = new LocalAmazonRuntime(profileDirectory, config.marketplace);
  await runtime.start();

  const handler = createLocalAgentHandler({
    secret,
    execute: (operation) => runtime.execute(operation),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    reusePort: false,
    fetch: handler,
    error: () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "The local browser operation could not be completed.",
          },
        }),
        {
          status: 500,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        },
      ),
  });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    await runtime.close();
  };
  process.once("SIGINT", () => {
    void stop().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stop().finally(() => process.exit(0));
  });

  console.log(`Local Amazon browser agent ready on 127.0.0.1:${config.port}.`);
}

function printUsage(): void {
  console.log(`Local Amazon browser agent

Usage:
  bun run local-agent:login   Open the fixed Amazon login flow in a dedicated profile.
  bun run local-agent:serve   Start the signed localhost-only four-operation service.

The service accepts only POST /execute. It provides no URL, click, type,
JavaScript, screenshot, download, cookie, password, or raw-page primitive.`);
}

if (import.meta.main) {
  void main().catch(() => {
    console.error("The local Amazon browser agent could not start safely.");
    process.exitCode = 1;
  });
}
