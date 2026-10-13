import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// GET /{page-id}/feed — list recent posts on the Page
// NanoClaw patch: also return each post's link and its comment, reaction and
// share counts, so the agent can see which posts did well.
const POST_FIELDS =
  "id,message,story,created_time,full_picture,permalink_url," +
  "comments.summary(true).limit(0),reactions.summary(true).limit(0),shares";

const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_get_posts",
    "Retrieve recent posts from the Facebook Page feed. Returns post ID, message, creation time, story, link, and comment/reaction/share counts.",
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
          `/${pageId}/feed?fields=${encodeURIComponent(POST_FIELDS)}&limit=${args.limit}`,
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
