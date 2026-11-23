'use strict';

const crypto = require('node:crypto');
const { AppError } = require('../utils/errors');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

/**
 * Optional shared-secret authentication.
 * When FORGE_API_KEY is empty, authentication is disabled.
 * Accepts `X-API-Key: <key>` or `Authorization: Bearer <key>`.
 */
function createAuth(expectedKey) {
  if (!expectedKey) return function noAuth() {};

  const expected = digest(expectedKey);

  return function authenticate(req) {
    let supplied = req.headers['x-api-key'];
    if (typeof supplied !== 'string' || supplied === '') {
      const header = req.headers.authorization;
      if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
        supplied = header.replace(/^Bearer\s+/i, '').trim();
      }
    }

    const valid =
      typeof supplied === 'string' && supplied !== '' && crypto.timingSafeEqual(digest(supplied), expected);

    if (!valid) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid API key.', {
        headers: { 'WWW-Authenticate': 'Bearer' },
      });
    }
  };
}

module.exports = { createAuth };
