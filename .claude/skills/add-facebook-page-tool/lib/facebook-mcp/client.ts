import { readFileSync } from "node:fs";
import { createLogger } from "./utils/logger.js";
import { createRateLimiter } from "./utils/rate-limiter.js";
import type { FacebookConfig, GraphApiResponse } from "./types.js";

const logger = createLogger("facebook");
const API_VERSION = "v25.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// NanoClaw patch: upstream never wired this file in (dead code in the
// original repo). We wire it here as a safety net against a runaway/looping
// agent spamming the Page — caps write actions (POST/DELETE), not reads.
// Default: 20 writes/hour, refilling continuously. Override with
// FACEBOOK_MAX_WRITES_PER_HOUR. See THIRD_PARTY_NOTICE.md.
const WRITE_METHODS = new Set(["POST", "DELETE"]);

// NanoClaw patch: the token can come from a file (FACEBOOK_PAGE_ACCESS_TOKEN_FILE)
// instead of the env var. Used when one agent manages several Pages: Meta
// needs a separate Page token per Page, and a host-pattern credential proxy
// can't tell them apart (comment IDs don't carry the Page ID), so each Page's
// server reads its own token from a read-only mount instead. See SKILL.md.
const readToken = (): string | undefined => {
  const { FACEBOOK_PAGE_ACCESS_TOKEN, FACEBOOK_PAGE_ACCESS_TOKEN_FILE } = process.env;
  if (FACEBOOK_PAGE_ACCESS_TOKEN_FILE) {
    try {
      return readFileSync(FACEBOOK_PAGE_ACCESS_TOKEN_FILE, "utf8").trim() || undefined;
    } catch {
      throw new Error(
        `Cannot read Facebook token file ${FACEBOOK_PAGE_ACCESS_TOKEN_FILE} (is it mounted?)`,
      );
    }
  }
  return FACEBOOK_PAGE_ACCESS_TOKEN || undefined;
};

const createClient = () => {
  const { FACEBOOK_PAGE_ID, FACEBOOK_MAX_WRITES_PER_HOUR } = process.env;
  const pageAccessToken = readToken();
  if (!FACEBOOK_PAGE_ID || !pageAccessToken) {
    throw new Error(
      "Missing Facebook credentials. Set FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN (or FACEBOOK_PAGE_ACCESS_TOKEN_FILE) env vars.",
    );
  }

  const config: FacebookConfig = {
    pageId: FACEBOOK_PAGE_ID,
    pageAccessToken,
    apiVersion: API_VERSION,
  };

  const maxWritesPerHour = Number(FACEBOOK_MAX_WRITES_PER_HOUR) || 20;
  const writeLimiter = createRateLimiter(maxWritesPerHour, maxWritesPerHour / 3600);

  const request = async <T = unknown>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<GraphApiResponse<T>> => {
    const method = (options.method ?? "GET").toUpperCase();
    if (WRITE_METHODS.has(method) && !writeLimiter.allowed()) {
      const retrySec = Math.ceil(writeLimiter.retryAfterMs() / 1000);
      throw new Error(
        `Rate limit: too many Facebook write actions (max ${maxWritesPerHour}/hour). Retry in ~${retrySec}s.`,
      );
    }

    // NanoClaw patch: upstream put the access token in the URL query string
    // (?access_token=...), which leaks it into logs/proxy access records and
    // doesn't work with a header-rewriting credential proxy. Moved to an
    // Authorization header — this is what makes the OneCLI gateway's
    // in-flight header injection work (the real token is swapped in by the
    // proxy; whatever value is in FACEBOOK_PAGE_ACCESS_TOKEN locally never
    // needs to be the real secret).
    const url = new URL(`${BASE_URL}${endpoint}`);
    const response = await fetch(url.toString(), {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.pageAccessToken}`,
        ...options.headers,
      },
    });
    const data = (await response.json()) as GraphApiResponse<T>;
    if (data.error) {
      throw new Error(
        `Graph API error: ${data.error.message} (code: ${data.error.code})`,
      );
    }
    return data;
  };

  logger.info("Facebook Graph API client initialized");
  return { config, request };
};

export { createClient };
export type FacebookClient = ReturnType<typeof createClient>;
