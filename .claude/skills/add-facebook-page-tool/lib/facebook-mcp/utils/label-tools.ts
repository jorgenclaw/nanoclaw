import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// NanoClaw patch: when one agent has a server per Page, every server exposes
// the same tool names. Prefixing each description with the Page's name tells
// the model which Page a tool acts on.
const labelTools = (server: McpServer, label: string | undefined): McpServer => {
  if (!label) return server;
  const tool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { tool: typeof tool }).tool = (name, description, ...rest) =>
    tool(name, `[Page: ${label}] ${description}`, ...rest);
  return server;
};

export { labelTools };
