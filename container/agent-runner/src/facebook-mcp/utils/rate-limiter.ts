interface RateLimiter {
  allowed(): boolean;
  retryAfterMs(): number;
}

const createRateLimiter = (
  maxTokens: number,
  refillPerSecond: number,
): RateLimiter => {
  let tokens = maxTokens;
  let lastRefill = Date.now();

  return {
    allowed() {
      const now = Date.now();
      tokens = Math.min(
        maxTokens,
        tokens + ((now - lastRefill) / 1000) * refillPerSecond,
      );
      lastRefill = now;
      if (tokens >= 1) {
        tokens--;
        return true;
      }
      return false;
    },
    retryAfterMs() {
      return Math.ceil(((1 - tokens) / refillPerSecond) * 1000);
    },
  };
};

export { createRateLimiter, type RateLimiter };
