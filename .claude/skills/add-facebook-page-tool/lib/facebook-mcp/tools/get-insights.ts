import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// GET /{page-id}/insights — retrieve Page-level analytics.
// Deprecated metrics (e.g. impressions, retired June 2026) are excluded —
// only current post-deprecation metric names are listed here.
const VALID_METRICS = [
  "page_views_total",
  "page_fans",
  "page_fan_adds",
  "page_fan_removes",
  "page_post_engagements",
  "page_reactions_total",
  "page_video_views",
  "page_website_clicks_logged_in_total",
] as const;

const VALID_PERIODS = ["day", "week", "days_28", "month", "lifetime"] as const;

const VALID_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "maximum",
] as const;

const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_get_insights",
    "Retrieve Page-level analytics insights from Facebook. Choose a metric, aggregation period, and optional date preset.",
    {
      metric: z
        .enum(VALID_METRICS)
        .default("page_views_total")
        .describe(
          "The insight metric to retrieve. Default: page_views_total. Deprecated metrics like impressions are excluded.",
        ),
      period: z
        .enum(VALID_PERIODS)
        .default("day")
        .describe(
          "Aggregation period: day, week, days_28, month, or lifetime. Default: day.",
        ),
      date_preset: z
        .enum(VALID_PRESETS)
        .optional()
        .describe(
          "Optional date preset (e.g. 'last_week', 'this_month'). Overrides since/until if provided.",
        ),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const { pageId } = client.config;
        let endpoint = `/${pageId}/insights?metric=${args.metric}&period=${args.period}`;
        if (args.date_preset) {
          endpoint += `&date_preset=${args.date_preset}`;
        }

        const result = await client.request(endpoint);

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
