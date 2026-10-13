import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";
import { uploadUnpublishedPhoto } from "../utils/media.js";

// NanoClaw addition: set the Page's cover photo and profile picture from a
// local image. Both upload the photo unpublished first (so nothing lands in
// the feed), then point the Page at the new photo ID.
const imagePath = z
  .string()
  .min(1)
  .describe("Local image file, e.g. /workspace/agent/cover.png (jpg, png, gif or webp, under 10 MB)");

const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_set_cover_photo",
    "Replace the Facebook Page's cover photo with a local image, without posting it to the feed. Best size 1640x624; phones crop the sides, so keep text and faces in the middle.",
    {
      image_path: imagePath,
      offset_y: z
        .number()
        .int()
        .min(0)
        .max(100)
        .default(50)
        .describe("Vertical position of the crop, 0 (top) to 100 (bottom). Default 50, centred."),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const photoId = await uploadUnpublishedPhoto(client, args.image_path);
        const { pageId } = client.config;
        const result = await client.request(`/${pageId}`, {
          method: "POST",
          body: JSON.stringify({ cover: photoId, offset_y: args.offset_y, no_feed_story: true }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ...(result as object), photo_id: photoId }, null, 2) }],
        };
      }),
  );

  server.tool(
    "facebook_set_profile_picture",
    "Replace the Facebook Page's profile picture with a local square image (at least 720x720). Facebook shows it as a circle, so keep the subject in the middle.",
    { image_path: imagePath },
    async (args) =>
      wrapToolHandler(async () => {
        const photoId = await uploadUnpublishedPhoto(client, args.image_path);
        const { pageId } = client.config;
        const result = await client.request(`/${pageId}/picture`, {
          method: "POST",
          body: JSON.stringify({ photo: photoId }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ...(result as object), photo_id: photoId }, null, 2) }],
        };
      }),
  );
};

export { register };
