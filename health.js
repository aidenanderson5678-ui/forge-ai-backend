'use strict';

const { CATEGORIES } = require('../prompts/categories');
const { version } = require('../../package.json');

/** GET /, GET /api/health and GET /api/categories */
function createInfoRoutes({ config }) {
  function health() {
    const issues = [];
    if (!config.ai.configured) {
      issues.push(
        config.ai.provider === 'anthropic'
          ? 'ANTHROPIC_API_KEY is not set.'
          : 'OPENAI_API_KEY and OPENAI_MODEL must both be set.',
      );
    }

    return {
      status: 200,
      body: {
        status: issues.length === 0 ? 'ok' : 'degraded',
        service: 'forge-ai-backend',
        version,
        environment: config.env,
        time: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        ai: { provider: config.ai.provider, model: config.ai.model || null, configured: config.ai.configured },
        auth: { required: config.auth.required },
        ...(issues.length > 0 && { issues }),
      },
    };
  }

  return [
    { method: 'GET', path: '/api/health', handler: health },
    {
      method: 'GET',
      path: '/',
      limiter: 'global',
      handler: () => ({
        status: 200,
        body: {
          service: 'forge-ai-backend',
          version,
          endpoints: ['GET /api/health', 'GET /api/categories', 'POST /api/generate'],
        },
      }),
    },
    {
      method: 'GET',
      path: '/api/categories',
      limiter: 'global',
      handler: () => ({
        status: 200,
        body: {
          success: true,
          data: {
            categories: CATEGORIES.filter((category) => category.id !== 'general').map(({ id, label, summary }) => ({
              id,
              label,
              summary,
            })),
          },
        },
      }),
    },
  ];
}

module.exports = { createInfoRoutes };
