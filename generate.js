'use strict';

const { AppError } = require('../utils/errors');
const { validateGenerateRequest } = require('../validation/generateRequest');

/** POST /api/generate */
function createGenerateRoute({ generator, config }) {
  let active = 0;

  return {
    method: 'POST',
    path: '/api/generate',
    auth: true,
    body: true,
    limiter: 'generate',

    async handler(ctx) {
      const request = validateGenerateRequest(ctx.body, config.limits);

      if (!config.ai.configured) {
        throw new AppError(
          503,
          'AI_NOT_CONFIGURED',
          'The AI provider is not configured on the server. The administrator must set the API key.',
        );
      }

      // Protect AI spend and memory: cap simultaneous generations.
      if (active >= config.limits.maxConcurrentGenerations) {
        throw new AppError(503, 'SERVER_BUSY', 'The server is busy generating other projects. Try again shortly.', {
          headers: { 'Retry-After': '5' },
        });
      }

      active += 1;
      try {
        const result = await generator.generate({
          request,
          requestId: ctx.requestId,
          signal: ctx.signal,
        });
        return {
          status: 200,
          body: { success: true, requestId: ctx.requestId, data: result.data, meta: result.meta },
        };
      } finally {
        active -= 1;
      }
    },
  };
}

module.exports = { createGenerateRoute };
