import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// GET /{post-id}/comments — list comments on a specific post
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_get_comments",
    "Retrieve comments on a specific Facebook post. Returns comment ID, message, author name, and creation time.",
    {
      post_id: z
        .string()
        .min(1)
        .describe("The Facebook post ID to fetch comments for"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("Number of comments to return (1-100, default 25)"),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const result = await client.request(
          `/${args.post_id}/comments?fields=id,message,from,created_time,can_hide,is_hidden&limit=${args.limit}`,
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
