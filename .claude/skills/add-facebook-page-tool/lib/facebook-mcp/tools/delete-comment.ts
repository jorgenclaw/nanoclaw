import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// NanoClaw addition: DELETE /{comment-id} — remove a comment for good (spam,
// scams). Hiding (facebook_hide_comment) is the gentler option and can be undone.
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_delete_comment",
    "Permanently delete a comment on one of the Facebook Page's posts. Use only for spam, scams or abuse; for anything else prefer facebook_hide_comment, which can be undone.",
    {
      comment_id: z.string().min(1).describe("The comment ID to delete"),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const result = await client.request(`/${args.comment_id}`, { method: "DELETE" });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }),
  );
};

export { register };
