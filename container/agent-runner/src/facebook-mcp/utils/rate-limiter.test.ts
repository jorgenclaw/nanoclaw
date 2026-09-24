import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "./rate-limiter.js";

describe("createRateLimiter", () => {
  test("allows up to maxTokens immediately, then blocks", () => {
    const limiter = createRateLimiter(3, 0 /* no refill within the test */);
    expect(limiter.allowed()).toBe(true);
    expect(limiter.allowed()).toBe(true);
    expect(limiter.allowed()).toBe(true);
    expect(limiter.allowed()).toBe(false);
  });

  test("retryAfterMs reports a positive wait once exhausted", () => {
    const limiter = createRateLimiter(1, 1 /* 1 token/sec refill */);
    expect(limiter.allowed()).toBe(true);
    expect(limiter.allowed()).toBe(false);
    expect(limiter.retryAfterMs()).toBeGreaterThan(0);
  });
});
