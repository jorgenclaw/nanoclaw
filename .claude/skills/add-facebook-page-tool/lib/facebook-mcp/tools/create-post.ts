import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";
import { uploadMedia } from "../utils/media.js";

// POST /{page-id}/feed — publish an immediate post to the Facebook Page.
//
// `picture` is a public image URL (Graph API shares it). NanoClaw patch:
// `media_path` uploads a local photo or video file instead, via
// POST /{page-id}/photos or /videos (see utils/media.ts).
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_create_post",
    "Create and publish an immediate post on the Facebook Page. Supports text, a link, a public image URL (picture), or a local photo or video file (media_path). Audio files are not supported by Facebook.",
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
      media_path: z
        .string()
        .optional()
        .describe(
          "Optional local photo or video file to upload with the post, e.g. /workspace/group/photo.jpg. Photos: jpg png gif webp. Videos: mp4 mov webm. Can't be combined with link or picture.",
        ),
    },
    async (args) =>
      wrapToolHandler(async () => {
        if (args.media_path) {
          if (args.link || args.picture) {
            throw new Error(
              "media_path can't be combined with link or picture. Put the link in the message text instead.",
            );
          }
          const result = await uploadMedia(client, args.media_path, {
            message: args.message,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

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
