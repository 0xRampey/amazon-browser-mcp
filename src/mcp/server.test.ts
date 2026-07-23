import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { AmazonGateway } from "./gateway";
import { createAmazonMcpServer } from "./server";

describe("Amazon MCP tools", () => {
  it("publishes exactly four read-only Amazon tools and no browser primitives", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const gateway: AmazonGateway = { execute: vi.fn(async () => ({ state: "authenticated" })) };
    const server = createAmazonMcpServer(gateway);
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "amazon_find_orders",
      "amazon_get_order",
      "amazon_list_orders",
      "amazon_session_status",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
    expect(tools.some((tool) => /click|type|fill|navigate|evaluate|url/i.test(tool.name))).toBe(false);

    await client.close();
    await server.close();
  });

  it("returns structured content and forwards only constrained operations", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const execute = vi.fn(async () => ({ orders: [], has_more: false }));
    const server = createAmazonMcpServer({ execute });
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "amazon_list_orders",
      arguments: { limit: 10, max_pages: 2 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { orders: [], has_more: false },
      provenance: { marketplace: "amazon.com", content_trust: "untrusted_web_data" },
    });
    expect(execute).toHaveBeenCalledWith({
      action: "list_orders",
      orderedFrom: undefined,
      orderedTo: undefined,
      statuses: undefined,
      limit: 10,
      maxPages: 2,
    });

    await client.close();
    await server.close();
  });

  it("rejects an inverted date range before opening a browser", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const execute = vi.fn(async () => ({}));
    const server = createAmazonMcpServer({ execute });
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "amazon_list_orders",
      arguments: { ordered_from: "2026-07-31", ordered_to: "2026-07-01" },
    });

    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });
});
