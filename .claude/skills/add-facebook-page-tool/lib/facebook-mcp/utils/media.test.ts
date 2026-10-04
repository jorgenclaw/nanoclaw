import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../client.js";
import { detectMedia, uploadMedia, uploadPhotoPost } from "./media.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.FACEBOOK_PAGE_ID = "12345";
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
});

const tempFile = (name: string, bytes = 16) => {
  const file = join(mkdtempSync(join(tmpdir(), "fb-media-")), name);
  writeFileSync(file, Buffer.alloc(bytes));
  return file;
};

describe("detectMedia", () => {
  test("recognizes photos and videos by extension, case-insensitively", () => {
    expect(detectMedia("/a/b.JPG").kind).toBe("photo");
    expect(detectMedia("/a/b.webp").kind).toBe("photo");
    expect(detectMedia("/a/b.mp4").kind).toBe("video");
    expect(detectMedia("/a/b.MOV").kind).toBe("video");
  });

  test("rejects audio with an explanation", () => {
    expect(() => detectMedia("/a/song.mp3")).toThrow(/can't post audio/);
  });

  test("rejects unknown types", () => {
    expect(() => detectMedia("/a/notes.txt")).toThrow(/Unsupported media file type/);
  });
});

describe("uploadMedia", () => {
  test("posts a photo as multipart to /photos with message, no JSON content type", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ id: "1", post_id: "12345_1" })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await uploadMedia(createClient(), tempFile("pic.png"), { message: "hello" });

    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/12345/photos");
    const headers = options.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer test-token");
    const form = options.body as FormData;
    expect(form.get("message")).toBe("hello");
    expect(form.get("source")).toBeInstanceOf(Blob);
    expect(form.has("published")).toBe(false);
  });

  test("posts a video to /videos with description and schedule fields", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ id: "9" })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await uploadMedia(createClient(), tempFile("clip.mp4"), {
      message: "watch",
      scheduledPublishTime: "1800000000",
    });

    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/12345/videos");
    const form = options.body as FormData;
    expect(form.get("description")).toBe("watch");
    expect(form.has("message")).toBe(false);
    expect(form.get("published")).toBe("false");
    expect(form.get("scheduled_publish_time")).toBe("1800000000");
  });

  test("a missing file gives a clear error and makes no request", async () => {
    const fetchMock = mock(async () => new Response("{}"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      uploadMedia(createClient(), "/nonexistent/pic.jpg", {}),
    ).rejects.toThrow(/Cannot read media file/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("an oversized photo is refused before uploading", async () => {
    const fetchMock = mock(async () => new Response("{}"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      uploadMedia(createClient(), tempFile("big.jpg", 11 * 1024 * 1024), {}),
    ).rejects.toThrow(/limit is 10 MB/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe("uploadPhotoPost", () => {
  const photoThenFeed = () => {
    let n = 0;
    return mock(async (url: string) =>
      new Response(JSON.stringify(String(url).includes("/feed") ? { id: "12345_99" } : { id: `p${++n}` })),
    );
  };

  test("uploads each photo unpublished, then one feed post attaching them all", async () => {
    const fetchMock = photoThenFeed();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await uploadPhotoPost(createClient(), [tempFile("a.jpg"), tempFile("b.png"), tempFile("c.webp")], {
      message: "market day",
    });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls).toHaveLength(4);
    for (const [url, options] of calls.slice(0, 3)) {
      expect(url).toContain("/12345/photos");
      const form = options.body as FormData;
      expect(form.get("published")).toBe("false");
      expect(form.has("temporary")).toBe(false);
      expect(form.has("message")).toBe(false);
    }
    const [feedUrl, feedOptions] = calls[3];
    expect(feedUrl).toContain("/12345/feed");
    const body = JSON.parse(feedOptions.body as string);
    expect(body.message).toBe("market day");
    expect(body.attached_media).toEqual([{ media_fbid: "p1" }, { media_fbid: "p2" }, { media_fbid: "p3" }]);
    expect(body.published).toBeUndefined();
    expect(result).toMatchObject({ id: "12345_99", photo_ids: ["p1", "p2", "p3"] });
  });

  test("a scheduled post uploads temporary photos and schedules the feed post", async () => {
    const fetchMock = photoThenFeed();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await uploadPhotoPost(createClient(), [tempFile("a.jpg"), tempFile("b.jpg")], {
      message: "soon",
      scheduledPublishTime: "1800000000",
    });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect((calls[0][1].body as FormData).get("temporary")).toBe("true");
    const body = JSON.parse(calls[2][1].body as string);
    expect(body.published).toBe(false);
    expect(body.scheduled_publish_time).toBe("1800000000");
  });

  test("a video in the list is refused before anything uploads", async () => {
    const fetchMock = photoThenFeed();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      uploadPhotoPost(createClient(), [tempFile("a.jpg"), tempFile("clip.mp4")], {}),
    ).rejects.toThrow(/can only hold photos/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("a missing file anywhere in the list is refused before anything uploads", async () => {
    const fetchMock = photoThenFeed();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      uploadPhotoPost(createClient(), [tempFile("a.jpg"), "/nonexistent/b.jpg"], {}),
    ).rejects.toThrow(/Cannot read media file/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("fewer than 2 or more than 10 photos is refused", async () => {
    await expect(uploadPhotoPost(createClient(), [tempFile("a.jpg")], {})).rejects.toThrow(/2 to 10 photos/);
    const eleven = Array.from({ length: 11 }, (_, i) => tempFile(`p${i}.jpg`));
    await expect(uploadPhotoPost(createClient(), eleven, {})).rejects.toThrow(/2 to 10 photos/);
  });

  test("a failed upload says how far it got and posts nothing", async () => {
    let n = 0;
    const fetchMock = mock(async () =>
      ++n === 2
        ? new Response(JSON.stringify({ error: { message: "bad image", code: 324 } }))
        : new Response(JSON.stringify({ id: `p${n}` })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      uploadPhotoPost(createClient(), [tempFile("a.jpg"), tempFile("b.jpg"), tempFile("c.jpg")], {}),
    ).rejects.toThrow(/b\.jpg failed after 1 of 3 photos; nothing was posted/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
