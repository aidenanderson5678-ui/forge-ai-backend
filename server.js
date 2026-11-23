'use strict';

const http = require('node:http');
const { loadConfig, loadDotEnv } = require('./config');
const { createLogger, serializeError } = require('./utils/logger');
const { createProvider } = require('./services/aiProvider');
const { createGenerator } = require('./services/generator');
const { createApp } = require('./app');

function start() {
  loadDotEnv();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel });
  const provider = createProvider(config.ai, logger);
  const generator = createGenerator({ provider, config, logger });
  const app = createApp({ config, logger, generator });

  const server = http.createServer(app);
  // Longer than the idle timeout of common reverse proxies, to avoid dropped connections.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  server.listen(config.port, config.host, () => {
    logger.info('forge-ai-backend listening', {
      host: config.host,
      port: config.port,
      environment: config.env,
      aiProvider: config.ai.provider,
      aiModel: config.ai.model || null,
      aiConfigured: config.ai.configured,
    });
    if (!config.ai.configured) {
      logger.warn('AI provider is not configured: POST /api/generate will return 503 until the API key is set.');
    }
    if (config.isProduction && config.cors.origins.includes('*')) {
      logger.warn('CORS_ORIGINS is "*" in production: set it to your frontend origin(s).');
    }
    if (config.isProduction && !config.auth.required) {
      logger.warn('FORGE_API_KEY is not set: anyone who finds the URL can spend your AI credits within the rate limits.');
    }
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    server.close(() => {
      app.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      logger.warn('forced shutdown after timeout');
      process.exit(1);
    }, 15000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: serializeError(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err: serializeError(err) });
    process.exit(1);
  });

  return server;
}

if (require.main === module) start();

module.exports = { start };
