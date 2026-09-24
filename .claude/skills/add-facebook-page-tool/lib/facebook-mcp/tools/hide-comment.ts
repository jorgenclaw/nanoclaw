import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// POST /{comment-id} with is_hidden — hide or unhide a comment on a Page post.
// Graph API has no "delete someone else's comment" capability for Pages;
// hiding is the real-world equivalent (visible to the commenter, not to others).
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_hide_comment",
    "Hide or unhide a comment on a Facebook Page post. Hidden comments are still visible to the commenter but not to others.",
    {
      comment_id: z.string().min(1).describe("The comment ID to hide or unhide"),
      hide: z
        .boolean()
        .describe("Set to true to hide the comment, false to unhide it"),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const result = await client.request(`/${args.comment_id}`, {
          method: "POST",
          body: JSON.stringify({
            is_hidden: args.hide,
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
