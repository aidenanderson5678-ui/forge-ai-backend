'use strict';

const MAX_TRACKED_KEYS = 50000;

/**
 * Fixed-window, in-memory rate limiter.
 * State lives in this process only: it resets on restart and is not shared
 * between multiple instances (fine for a single free-tier instance).
 */
function createRateLimiter({ windowMs, max, now = Date.now }) {
  const hits = new Map();

  function prune() {
    const t = now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= t) hits.delete(key);
    }
  }

  function check(key) {
    const t = now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= t) {
      if (!entry && hits.size >= MAX_TRACKED_KEYS) {
        prune();
        if (hits.size >= MAX_TRACKED_KEYS) hits.clear();
      }
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;
    return {
      allowed: entry.count <= max,
      limit: max,
      remaining: Math.max(0, max - entry.count),
      resetSeconds: Math.max(0, Math.ceil((entry.resetAt - t) / 1000)),
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)),
    };
  }

  const timer = setInterval(prune, Math.max(windowMs, 10000));
  timer.unref();

  return {
    check,
    stop: () => clearInterval(timer),
    size: () => hits.size,
  };
}

module.exports = { createRateLimiter };
