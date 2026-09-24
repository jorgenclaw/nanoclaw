import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// POST /{comment-id}/comments — reply to an existing comment
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_reply_comment",
    "Reply to an existing comment on a Facebook post by posting a sub-comment.",
    {
      comment_id: z.string().min(1).describe("The comment ID to reply to"),
      message: z.string().min(1).describe("The reply message text"),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const result = await client.request(`/${args.comment_id}/comments`, {
          method: "POST",
          body: JSON.stringify({
            message: args.message,
          }),
        });

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
