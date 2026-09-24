import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "./client.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FACEBOOK_")) delete process.env[key];
  }
  process.env = { ...ORIGINAL_ENV };
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetEnv();
});

describe("createClient", () => {
  test("throws when FACEBOOK_PAGE_ID is missing", () => {
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "token";
    delete process.env.FACEBOOK_PAGE_ID;
    expect(() => createClient()).toThrow(/Missing Facebook credentials/);
  });

  test("throws when FACEBOOK_PAGE_ACCESS_TOKEN is missing", () => {
    process.env.FACEBOOK_PAGE_ID = "12345";
    delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    expect(() => createClient()).toThrow(/Missing Facebook credentials/);
  });

  test("succeeds and exposes config when both env vars are set", () => {
    process.env.FACEBOOK_PAGE_ID = "12345";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "onecli-managed";
    const client = createClient();
    expect(client.config.pageId).toBe("12345");
    expect(client.config.pageAccessToken).toBe("onecli-managed");
  });
});

describe("token file", () => {
  test("reads the token from FACEBOOK_PAGE_ACCESS_TOKEN_FILE and trims it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fb-")), "page.token");
    writeFileSync(file, "file-token\n");
    process.env.FACEBOOK_PAGE_ID = "12345";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN_FILE = file;
    expect(createClient().config.pageAccessToken).toBe("file-token");
  });

  test("the file wins over FACEBOOK_PAGE_ACCESS_TOKEN", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fb-")), "page.token");
    writeFileSync(file, "file-token");
    process.env.FACEBOOK_PAGE_ID = "12345";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "env-token";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN_FILE = file;
    expect(createClient().config.pageAccessToken).toBe("file-token");
  });

  test("throws a clear error when the file is missing, without the token", () => {
    process.env.FACEBOOK_PAGE_ID = "12345";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN_FILE = "/nonexistent/page.token";
    expect(() => createClient()).toThrow(/Cannot read Facebook token file/);
  });

  test("an empty file counts as missing", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fb-")), "page.token");
    writeFileSync(file, "  \n");
    process.env.FACEBOOK_PAGE_ID = "12345";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN_FILE = file;
    expect(() => createClient()).toThrow(/Missing Facebook credentials/);
  });
});

describe("request()", () => {
  beforeEach(() => {
    process.env.FACEBOOK_PAGE_ID = "12345";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "test-token";
  });

  test("sends the token as an Authorization header, never in the URL", async () => {
    const fetchMock = mock(async (url: string | URL) => {
      const u = new URL(url.toString());
      expect(u.searchParams.has("access_token")).toBe(false);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClient();
    await client.request("/12345/feed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  test("throws a formatted error on a Graph API error response", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ error: { message: "Invalid OAuth token", type: "OAuthException", code: 190 } }),
        { status: 400 },
      ),
    ) as unknown as typeof fetch;

    const client = createClient();
    await expect(client.request("/12345/feed")).rejects.toThrow(/code: 190/);
  });

  test("allows GET requests past the write rate limiter", async () => {
    process.env.FACEBOOK_MAX_WRITES_PER_HOUR = "1";
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch;
    const client = createClient();

    // Exhaust the (tiny) write budget, then confirm GET is still unaffected.
    await client.request("/12345/feed", { method: "POST", body: "{}" });
    await client.request("/12345/feed"); // GET, default method
  });

  test("blocks writes once the per-hour budget is exhausted", async () => {
    process.env.FACEBOOK_MAX_WRITES_PER_HOUR = "1";
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch;
    const client = createClient();

    await client.request("/12345/feed", { method: "POST", body: "{}" });
    await expect(
      client.request("/12345/feed", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/Rate limit/);
  });
});
