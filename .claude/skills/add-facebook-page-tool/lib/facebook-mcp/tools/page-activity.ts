import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// NanoClaw addition: read-only views of what's happening around the Page —
// recommendations (reviews), the queue of scheduled posts, and posts by other
// people that tag the Page. Reading other people's posts needs
// pages_read_user_content.
const limit = z.number().int().min(1).max(100).default(25).describe("How many to return (1-100, default 25)");

const listTool = (
  server: McpServer,
  client: FacebookClient,
  name: string,
  description: string,
  edge: string,
  fields: string,
) => {
  server.tool(name, description, { limit }, async (args) =>
    wrapToolHandler(async () => {
      const { pageId } = client.config;
      const result = await client.request(
        `/${pageId}/${edge}?fields=${encodeURIComponent(fields)}&limit=${args.limit}`,
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );
};

const register = (server: McpServer, client: FacebookClient) => {
  listTool(
    server,
    client,
    "facebook_get_recommendations",
    "List recommendations (reviews) people have left on the Facebook Page: whether they recommend it, their text, and when. Facebook doesn't share who wrote them through this tool.",
    "ratings",
    "created_time,recommendation_type,review_text,rating",
  );
  listTool(
    server,
    client,
    "facebook_get_scheduled_posts",
    "List the Facebook Page's posts that are scheduled but not yet published, with their text and publish time. Use it to check the queue before scheduling more, or to find a post ID to edit or delete.",
    "scheduled_posts",
    "id,message,scheduled_publish_time,created_time,full_picture",
  );
  listTool(
    server,
    client,
    "facebook_get_mentions",
    "List posts by other people or Pages that tag this Facebook Page, newest first, with a link to each.",
    "tagged",
    "id,message,created_time,permalink_url,from",
  );
};

export { register };
