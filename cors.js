'use strict';

/**
 * CORS handling for a browser-based Studio Lite frontend.
 *
 * - Requests without an Origin header (curl, server-to-server) are allowed.
 * - Requests whose Origin is not in the allow-list are reported as not allowed so
 *   the caller can reject them (this also stops cross-site pages from spending
 *   your AI credits).
 * - Note: a page opened from a local file sends the origin "null"; add `null` to
 *   CORS_ORIGINS only for local testing.
 */
function createCors(allowedOrigins) {
  const allowAny = allowedOrigins.includes('*');
  const allowed = new Set(allowedOrigins);

  return function applyCors(req, res) {
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (!origin) return { allowed: true };

    const ok = allowAny || allowed.has(origin);
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', allowAny ? '*' : origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Request-Id');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After',
      );
      res.setHeader('Access-Control-Max-Age', '600');
    }
    return { allowed: ok };
  };
}

module.exports = { createCors };
