import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { register as registerCreatePost } from "./create-post.js";
import { register as registerSchedulePost } from "./schedule-post.js";
import { register as registerDeletePost } from "./delete-post.js";
import { register as registerGetPosts } from "./get-posts.js";
import { register as registerGetComments } from "./get-comments.js";
import { register as registerReplyComment } from "./reply-comment.js";
import { register as registerHideComment } from "./hide-comment.js";
import { register as registerGetInsights } from "./get-insights.js";

// Register all Facebook Page management tools with the MCP server
const registerAllTools = (server: McpServer, client: FacebookClient): void => {
  registerCreatePost(server, client);
  registerSchedulePost(server, client);
  registerDeletePost(server, client);
  registerGetPosts(server, client);
  registerGetComments(server, client);
  registerReplyComment(server, client);
  registerHideComment(server, client);
  registerGetInsights(server, client);
};

export { registerAllTools };
