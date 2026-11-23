'use strict';

const crypto = require('node:crypto');
const { AppError, ClientAbortedError } = require('./utils/errors');
const { serializeError } = require('./utils/logger');
const { sendJson, getClientIp } = require('./utils/http');
const { readJsonBody } = require('./middleware/body');
const { createCors } = require('./middleware/cors');
const { createAuth } = require('./middleware/auth');
const { createRateLimiter } = require('./middleware/rateLimit');
const { buildRoutes } = require('./routes');

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Creates the HTTP request handler (use with http.createServer).
 * Pipeline per request: request id and security headers -> CORS -> route match ->
 * rate limit -> authentication -> body parsing -> route handler -> JSON response.
 */
function createApp({ config, logger, generator }) {
  const applyCors = createCors(config.cors.origins);
  const authenticate = createAuth(config.auth.apiKey);
  const limiters = {
    global: createRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max }),
    generate: createRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.generateMax }),
  };

  const routesByPath = new Map();
  for (const route of buildRoutes({ config, logger, generator })) {
    if (!routesByPath.has(route.path)) routesByPath.set(route.path, new Map());
    routesByPath.get(route.path).set(route.method, route);
  }

  async function handle(req, res) {
    const startedAt = process.hrtime.bigint();
    const inboundId = req.headers['x-request-id'];
    const requestId = typeof inboundId === 'string' && REQUEST_ID_RE.test(inboundId) ? inboundId : crypto.randomUUID();
    const ip = getClientIp(req, config.proxy.hops);
    const logPath = String(req.url || '').split('?')[0].slice(0, 200);

    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    // Aborts in-flight AI calls when the client disconnects, so no credits are wasted.
    const abort = new AbortController();
    res.on('close', () => {
      const aborted = !res.writableFinished;
      if (aborted) abort.abort();
      logger.info('request', {
        requestId,
        method: req.method,
        path: logPath,
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
        ip,
        ...(aborted && { aborted: true }),
      });
    });

    try {
      const cors = applyCors(req, res);
      if (!cors.allowed) {
        throw new AppError(403, 'CORS_ORIGIN_DENIED', 'This origin is not allowed to use the API.');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        throw new AppError(400, 'BAD_URL', 'Malformed request URL.');
      }
      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

      const methods = routesByPath.get(pathname);
      if (!methods) {
        throw new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${pathname.slice(0, 100)}.`);
      }

      const route = methods.get(req.method) || (req.method === 'HEAD' ? methods.get('GET') : undefined);
      if (!route) {
        const allowed = [...methods.keys()];
        throw new AppError(405, 'METHOD_NOT_ALLOWED', `Use ${allowed.join(' or ')} for ${pathname}.`, {
          headers: { Allow: [...allowed, 'OPTIONS'].join(', ') },
        });
      }

      if (route.limiter) {
        const verdict = limiters[route.limiter].check(`${route.limiter}:${ip}`);
        res.setHeader('RateLimit-Limit', String(verdict.limit));
        res.setHeader('RateLimit-Remaining', String(verdict.remaining));
        res.setHeader('RateLimit-Reset', String(verdict.resetSeconds));
        if (!verdict.allowed) {
          throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.', {
            headers: { 'Retry-After': String(verdict.retryAfterSec) },
          });
        }
      }

      if (route.auth) authenticate(req);

      const body = route.body ? await readJsonBody(req, { limit: config.limits.maxBodyBytes }) : undefined;

      const result = await route.handler({ req, res, url, requestId, body, ip, signal: abort.signal });
      sendJson(res, result.status, result.body, result.headers);
    } catch (err) {
      if (err instanceof ClientAbortedError || res.headersSent || res.destroyed) return;

      if (err instanceof AppError) {
        if (err.status >= 500) logger.warn('request failed', { requestId, code: err.code });
        sendJson(
          res,
          err.status,
          {
            success: false,
            requestId,
            error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
          },
          err.headers,
        );
        return;
      }

      logger.error('unhandled error', { requestId, err: serializeError(err) });
      sendJson(res, 500, {
        success: false,
        requestId,
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' },
      });
    }
  }

  handle.close = () => {
    limiters.global.stop();
    limiters.generate.stop();
  };

  return handle;
}

module.exports = { createApp };
