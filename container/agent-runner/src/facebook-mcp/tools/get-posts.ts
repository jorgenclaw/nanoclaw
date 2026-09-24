import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// GET /{page-id}/feed — list recent posts on the Page
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_get_posts",
    "Retrieve recent posts from the Facebook Page feed. Returns post ID, message, creation time, and story.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Number of posts to return (1-100, default 10)"),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const { pageId } = client.config;
        const result = await client.request(
          `/${pageId}/feed?fields=id,message,story,created_time,full_picture&limit=${args.limit}`,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }),
  );
};

export { register };
