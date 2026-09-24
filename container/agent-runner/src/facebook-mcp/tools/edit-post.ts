import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// NanoClaw addition: POST /{post-id} with a new message — fix a post's text
// in place, keeping its comments and reactions. The Graph API can't change a
// published post's link or attachment; for that, delete and recreate.
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_edit_post",
    "Change the text of an existing post on the Facebook Page, keeping its comments and reactions. Only the text can be changed; a post's link or photo can't be edited (delete and recreate for that).",
    {
      post_id: z
        .string()
        .min(1)
        .describe(
          "The Facebook post ID to edit (e.g. '123456789012345_987654321098765')",
        ),
      message: z.string().min(1).describe("The new full text of the post"),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const result = await client.request(`/${args.post_id}`, {
          method: "POST",
          body: JSON.stringify({ message: args.message }),
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
