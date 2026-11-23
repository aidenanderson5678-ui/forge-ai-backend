'use strict';

/** Writes a JSON response with correct headers. */
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Determines the client IP. With `hops` = 0 only the socket address is trusted.
 * With `hops` = N, the Nth entry from the right of X-Forwarded-For is used, which
 * is the address the outermost trusted proxy saw (entries further left can be
 * forged by the client).
 */
function getClientIp(req, hops = 0) {
  const socketIp = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!hops) return socketIp;

  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || header === '') return socketIp;

  const list = header
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (list.length === 0) return socketIp;

  const index = list.length - hops;
  return list[index >= 0 ? index : 0];
}

module.exports = { sendJson, getClientIp };
