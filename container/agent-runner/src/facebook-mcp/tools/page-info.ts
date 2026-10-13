import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { wrapToolHandler } from "../utils/error-handler.js";

// NanoClaw addition: read and edit the Page's own profile (About text,
// description, website, contact details, categories). GET/POST /{page-id},
// needs pages_manage_metadata. Category IDs come from GET /fb_page_categories.
const PAGE_FIELDS = [
  "name",
  "username",
  "link",
  "about",
  "description",
  "category_list",
  "website",
  "phone",
  "emails",
  "hours",
  "followers_count",
  "fan_count",
  "call_to_actions{type,status}",
  "cover{source}",
  "picture.type(large){url}",
].join(",");

const register = (server: McpServer, client: FacebookClient) => {
  server.tool(
    "facebook_get_page_info",
    "Read the Facebook Page's own profile: name, About text, description, categories, website, phone, email, hours, follower count, buttons, cover photo and profile picture. Check this before changing anything with facebook_update_page_info.",
    {},
    async () =>
      wrapToolHandler(async () => {
        const { pageId } = client.config;
        const result = await client.request(`/${pageId}?fields=${encodeURIComponent(PAGE_FIELDS)}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }),
  );

  server.tool(
    "facebook_update_page_info",
    "Change the Facebook Page's own profile: the short About text, the longer description, website, phone, email, or categories. Only the fields you pass are changed. Read the current values with facebook_get_page_info first.",
    {
      about: z
        .string()
        .max(255)
        .optional()
        .describe("Short About text shown on the Page (at most 255 characters)"),
      description: z
        .string()
        .optional()
        .describe("Longer description ('Additional information' on the Page)"),
      website: z.string().url().optional().describe("Website address, e.g. https://example.com/"),
      phone: z.string().optional().describe("Phone number, e.g. +12095551234"),
      emails: z.array(z.string().email()).min(1).optional().describe("Contact email addresses"),
      category_ids: z
        .array(z.string().regex(/^\d+$/))
        .min(1)
        .max(3)
        .optional()
        .describe(
          "Up to 3 Facebook category IDs (numbers as strings), replacing the current categories. The first is the main one.",
        ),
    },
    async (args) =>
      wrapToolHandler(async () => {
        const body: Record<string, unknown> = {};
        if (args.about !== undefined) body.about = args.about;
        if (args.description !== undefined) body.description = args.description;
        if (args.website !== undefined) body.website = args.website;
        if (args.phone !== undefined) body.phone = args.phone;
        if (args.emails !== undefined) body.emails = args.emails;
        if (args.category_ids !== undefined) body.category_list = args.category_ids;
        if (Object.keys(body).length === 0) {
          throw new Error("Nothing to change: pass at least one field.");
        }
        const { pageId } = client.config;
        const result = await client.request(`/${pageId}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...(result as object), changed: Object.keys(body) }, null, 2),
            },
          ],
        };
      }),
  );
};

export { register };
