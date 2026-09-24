/**
 * Facebook Page management MCP server — vendored from lmtNoLimit/mcp-facebook
 * (MIT). See THIRD_PARTY_NOTICE.md in this directory for provenance and the
 * full list of NanoClaw patches (Authorization-header auth instead of a
 * query-string token, a wired-in write-rate-limiter, no stack traces in tool
 * results). Runs as its own stdio MCP server process — registered per agent
 * group via `ncl groups config add-mcp-server`, not baked into every group.
 *
 * Requires FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN in the server's
 * env (see SKILL.md). The token value only needs to be non-empty — the real
 * secret is injected in flight by the OneCLI gateway's proxy, matched by
 * host pattern on graph.facebook.com. For several Pages in one agent, register
 * one server per Page with FACEBOOK_PAGE_ACCESS_TOKEN_FILE and FACEBOOK_PAGE_LABEL
 * (see SKILL.md, "Managing more than one Page").
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "./client.js";
import { registerAllTools } from "./tools/index.js";
import { labelTools } from "./utils/label-tools.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("facebook");

const main = async () => {
  const server = new McpServer({
    name: "nanoclaw-facebook",
    version: "1.0.0",
  });
  const client = createClient();
  registerAllTools(labelTools(server, process.env.FACEBOOK_PAGE_LABEL), client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP Facebook server running on stdio");
};

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
