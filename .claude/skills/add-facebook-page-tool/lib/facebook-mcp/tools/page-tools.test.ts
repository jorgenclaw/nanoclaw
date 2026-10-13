import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FacebookClient } from "../client.js";
import { registerAllTools } from "./index.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

// A fake server that keeps each tool's handler, and a fake client that records
// every Graph API call and answers with `reply`.
const setup = (reply: (endpoint: string, options: RequestInit) => unknown = () => ({ success: true })) => {
  const handlers: Record<string, Handler> = {};
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  const request = mock(async (endpoint: string, options: RequestInit = {}) => reply(endpoint, options));
  const client = { config: { pageId: "PAGE", pageAccessToken: "t", apiVersion: "v25.0" }, request } as unknown as FacebookClient;
  registerAllTools(server, client);
  return { handlers, request };
};

const image = () => {
  const file = join(mkdtempSync(join(tmpdir(), "fb-")), "img.png");
  writeFileSync(file, "png");
  return file;
};

describe("page info", () => {
  test("get_page_info reads the Page's own fields", async () => {
    const { handlers, request } = setup();
    await handlers.facebook_get_page_info({});
    const [endpoint] = request.mock.calls[0];
    expect(endpoint).toStartWith("/PAGE?fields=");
    expect(decodeURIComponent(endpoint)).toContain("about,description,category_list");
  });

  test("update_page_info sends only the fields passed, categories as category_list", async () => {
    const { handlers, request } = setup();
    const res = await handlers.facebook_update_page_info({ about: "Hi", category_ids: ["2248"] });
    const [endpoint, options] = request.mock.calls[0];
    expect(endpoint).toBe("/PAGE");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({ about: "Hi", category_list: ["2248"] });
    expect(JSON.parse(res.content[0].text).changed).toEqual(["about", "category_list"]);
  });

  test("update_page_info with nothing to change is an error, not a call", async () => {
    const { handlers, request } = setup();
    const res = await handlers.facebook_update_page_info({});
    expect(res.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("page images", () => {
  const photoReply = (endpoint: string) => (endpoint.endsWith("/photos") ? { id: "PHOTO" } : { success: true });

  test("set_cover_photo uploads unpublished, then sets the cover without a feed story", async () => {
    const { handlers, request } = setup(photoReply);
    await handlers.facebook_set_cover_photo({ image_path: image(), offset_y: 50 });
    const [upEndpoint, upOptions] = request.mock.calls[0];
    expect(upEndpoint).toBe("/PAGE/photos");
    expect((upOptions.body as FormData).get("published")).toBe("false");
    const [endpoint, options] = request.mock.calls[1];
    expect(endpoint).toBe("/PAGE");
    expect(JSON.parse(options.body as string)).toEqual({ cover: "PHOTO", offset_y: 50, no_feed_story: true });
  });

  test("set_profile_picture points the Page picture at the uploaded photo", async () => {
    const { handlers, request } = setup(photoReply);
    await handlers.facebook_set_profile_picture({ image_path: image() });
    const [endpoint, options] = request.mock.calls[1];
    expect(endpoint).toBe("/PAGE/picture");
    expect(JSON.parse(options.body as string)).toEqual({ photo: "PHOTO" });
  });

  test("a video file is refused before anything is uploaded", async () => {
    const { handlers, request } = setup(photoReply);
    const file = join(mkdtempSync(join(tmpdir(), "fb-")), "clip.mp4");
    writeFileSync(file, "mp4");
    const res = await handlers.facebook_set_cover_photo({ image_path: file, offset_y: 50 });
    expect(res.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("page activity", () => {
  test.each([
    ["facebook_get_recommendations", "/PAGE/ratings?"],
    ["facebook_get_scheduled_posts", "/PAGE/scheduled_posts?"],
    ["facebook_get_mentions", "/PAGE/tagged?"],
  ])("%s reads %s", async (name, prefix) => {
    const { handlers, request } = setup(() => ({ data: [] }));
    await handlers[name]({ limit: 5 });
    const [endpoint] = request.mock.calls[0];
    expect(endpoint).toStartWith(prefix);
    expect(endpoint).toEndWith("&limit=5");
  });

  test("delete_comment sends DELETE to the comment", async () => {
    const { handlers, request } = setup();
    await handlers.facebook_delete_comment({ comment_id: "C1" });
    const [endpoint, options] = request.mock.calls[0];
    expect(endpoint).toBe("/C1");
    expect(options.method).toBe("DELETE");
  });

  test("get_posts includes engagement counts", async () => {
    const { handlers, request } = setup(() => ({ data: [] }));
    await handlers.facebook_get_posts({ limit: 3 });
    expect(decodeURIComponent(request.mock.calls[0][0])).toContain("reactions.summary(true)");
  });
});
