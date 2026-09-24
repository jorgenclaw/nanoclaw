import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// 10 minutes minimum, 6 months maximum scheduling window
const MIN_SCHEDULE_MS = 10 * 60 * 1000;
const MAX_SCHEDULE_MS = 6 * 30 * 24 * 60 * 60 * 1000;

// POST /{page-id}/feed — schedule a future post with published=false
const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_schedule_post",
    "Schedule a Facebook Page post for a future time. The scheduled_time must be between 10 minutes and 6 months from now (ISO 8601 format).",
    {
      message: z
        .string()
        .min(1)
        .describe("The text content of the post to schedule"),
      scheduled_time: z
        .string()
        .describe(
          "ISO 8601 datetime string for when to publish (e.g. 2026-04-01T14:00:00Z). Must be 10 min to 6 months from now.",
        ),
      link: z
        .string()
        .url()
        .optional()
        .describe("Optional URL to attach to the post"),
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
            "scheduled_time must be no more than 6 months in the future.",
          );
        }

        // Graph API requires UNIX timestamp in seconds
        const scheduledPublishTime = Math.floor(
          scheduledDate.getTime() / 1000,
        ).toString();

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
