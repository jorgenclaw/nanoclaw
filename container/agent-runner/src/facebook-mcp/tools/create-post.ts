import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";
import { MAX_PHOTOS_PER_POST, uploadMedia, uploadPhotoPost } from "../utils/media.js";

// POST /{page-id}/feed — publish an immediate post to the Facebook Page.
//
// `picture` is a public image URL (Graph API shares it). NanoClaw patch:
// `media_path` uploads a local photo or video file instead, via
// POST /{page-id}/photos or /videos (see utils/media.ts). `media_paths` posts
// several photos together (uploadPhotoPost in utils/media.ts).
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_create_post",
    "Create and publish an immediate post on the Facebook Page. Supports text, a link, a public image URL (picture), a local photo or video file (media_path), or several local photos in one post (media_paths). Audio files are not supported by Facebook.",
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
      media_paths: z
        .array(z.string())
        .min(1)
        .max(MAX_PHOTOS_PER_POST)
        .optional()
        .describe(
          `Optional list of local photo files to post together in one post (2 to ${MAX_PHOTOS_PER_POST}), e.g. ["/workspace/agent/a.jpg", "/workspace/agent/b.jpg"]. Photos only. Use instead of media_path, not with it. Each photo counts toward the hourly write limit.`,
        ),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const paths = args.media_paths ?? (args.media_path ? [args.media_path] : []);
        if (args.media_path && args.media_paths) {
          throw new Error("Use media_path or media_paths, not both.");
        }
        if (paths.length > 0) {
          if (args.link || args.picture) {
            throw new Error(
              "media_path/media_paths can't be combined with link or picture. Put the link in the message text instead.",
            );
          }
          const options = { message: args.message };
          const result =
            paths.length === 1
              ? await uploadMedia(client, paths[0], options)
              : await uploadPhotoPost(client, paths, options);
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
