import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// DELETE /{post-id} — permanently remove a post from the Page
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_delete_post",
    "Permanently delete a post from the Facebook Page by its post ID.",
    {
      post_id: z
        .string()
        .min(1)
        .describe(
          "The Facebook post ID to delete (e.g. '123456789012345_987654321098765')",
        ),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const result = await client.request(`/${args.post_id}`, {
          method: "DELETE",
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
