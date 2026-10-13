import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";
import { MAX_PHOTOS_PER_POST, uploadMedia, uploadPhotoPost } from "../utils/media.js";

// 10 minutes minimum, 30 days maximum. Facebook rejects anything later with a bare
// "(#100) The specified scheduled publish time is invalid" (measured 2026-10-03:
// 29 days accepted, 31 refused).
const MIN_SCHEDULE_MS = 10 * 60 * 1000;
const MAX_SCHEDULE_MS = 30 * 24 * 60 * 60 * 1000;

// POST /{page-id}/feed — schedule a future post with published=false
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_schedule_post",
    "Schedule a Facebook Page post for a future time. The scheduled_time must be between 10 minutes and 30 days from now (ISO 8601 format). Can include a link, a local photo or video file (media_path), or several local photos in one post (media_paths).",
    {
      message: z
        .string()
        .min(1)
        .describe("The text content of the post to schedule"),
      scheduled_time: z
        .string()
        .describe(
          // NanoClaw patch: the example used to be a UTC time ("...Z"), and an agent
          // copied that shape for a local time, so a 10 AM post went out at 3 AM
          // Pacific. Show a local time with its offset instead.
          "When to publish, as an ISO 8601 datetime WITH the local UTC offset, e.g. 2026-11-10T10:00:00-08:00 for 10 AM Pacific in winter (-07:00 in summer). A time ending in Z is UTC, not local time. Must be 10 min to 30 days from now.",
        ),
      link: z
        .string()
        .url()
        .optional()
        .describe("Optional URL to attach to the post"),
      media_path: z
        .string()
        .optional()
        .describe(
          "Optional local photo or video file to upload with the post, e.g. /workspace/group/photo.jpg. Photos: jpg png gif webp. Videos: mp4 mov webm. Can't be combined with link.",
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
        const scheduledDate = new Date(args.scheduled_time);
        if (isNaN(scheduledDate.getTime())) {
          throw new Error(
            `Invalid scheduled_time: "${args.scheduled_time}". Must be a valid ISO 8601 datetime.`,
          );
        }

        const now = Date.now();
        const diff = scheduledDate.getTime() - now;

        if (diff < MIN_SCHEDULE_MS) {
          throw new Error(
            "scheduled_time must be at least 10 minutes in the future.",
          );
        }
        if (diff > MAX_SCHEDULE_MS) {
          throw new Error(
            "scheduled_time must be no more than 30 days in the future (Facebook's limit).",
          );
        }

        // Graph API requires UNIX timestamp in seconds
        const scheduledPublishTime = Math.floor(
          scheduledDate.getTime() / 1000,
        ).toString();

        const paths = args.media_paths ?? (args.media_path ? [args.media_path] : []);
        if (args.media_path && args.media_paths) {
          throw new Error("Use media_path or media_paths, not both.");
        }
        if (paths.length > 0) {
          if (args.link) {
            throw new Error(
              "media_path/media_paths can't be combined with link. Put the link in the message text instead.",
            );
          }
          const options = { message: args.message, scheduledPublishTime };
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
          published: "false",
          scheduled_publish_time: scheduledPublishTime,
        };
        if (args.link) body.link = args.link;

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
