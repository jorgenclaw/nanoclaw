import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { labelTools } from "./label-tools.js";

const fakeServer = () => {
  const calls: unknown[][] = [];
  const server = { tool: (...args: unknown[]) => calls.push(args) } as unknown as McpServer;
  return { server, calls };
};

describe("labelTools", () => {
  test("prefixes each tool description with the Page label", () => {
    const { server, calls } = fakeServer();
    labelTools(server, "San Joaquin Victory Gardens").tool("facebook_get_posts", "List posts.", {}, async () => ({ content: [] }));
    expect(calls[0][0]).toBe("facebook_get_posts");
    expect(calls[0][1]).toBe("[Page: San Joaquin Victory Gardens] List posts.");
    expect(calls[0]).toHaveLength(4);
  });

  test("leaves descriptions alone when no label is set", () => {
    const { server, calls } = fakeServer();
    labelTools(server, undefined).tool("facebook_get_posts", "List posts.", {}, async () => ({ content: [] }));
    expect(calls[0][1]).toBe("List posts.");
  });
});
