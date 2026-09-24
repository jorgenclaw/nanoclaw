import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// POST /{page-id}/feed — publish an immediate post to the Facebook Page.
//
// NOTE: `picture` must be a URL to an already-publicly-hosted image (Graph
// API shares it, it does not upload a local file). This tool cannot post a
// local image file directly — that needs the binary-upload endpoint
// (POST /{page-id}/photos with multipart form data), which upstream never
// implemented and this vendor pass didn't add either. If Jorgenclaw needs to
// post local/unhosted images, that's a follow-up, not a v1 gap to paper over.
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_create_post",
    "Create and publish an immediate post on the Facebook Page. Supports text, link, and picture attachments (picture must be a public image URL, not a local file).",
    {
      message: z.string().min(1).describe("The text content of the post"),
      link: z
        .string()
        .url()
        .optional()
        .describe("Optional URL to attach to the post"),
      picture: z
        .string()
        .url()
        .optional()
        .describe("Optional public image URL to attach to the post"),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const { pageId } = client.config;
        const body: Record<string, string> = {
          message: args.message,
        };
        if (args.link) body.link = args.link;
        if (args.picture) body.picture = args.picture;

        const result = await client.request(`/${pageId}/feed`, {
          method: "POST",
          body: JSON.stringify(body),
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
