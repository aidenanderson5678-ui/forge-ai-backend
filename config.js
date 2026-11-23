'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Loads a local .env file (development convenience). Variables that are already
 * set in the real environment always win, so hosting dashboards override .env.
 */
function loadDotEnv(dir = process.cwd()) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return false;
  if (typeof process.loadEnvFile !== 'function') {
    console.warn('A .env file exists but this Node.js version cannot load it. Use Node.js 20.12 or newer.');
    return false;
  }
  process.loadEnvFile(file);
  return true;
}

function isBlank(value) {
  return value === undefined || String(value).trim() === '';
}

function readInt(env, name, fallback, min, max) {
  if (isBlank(env[name])) return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}="${env[name]}": expected an integer between ${min} and ${max}.`);
  }
  return value;
}

function readOptionalNumber(env, name, min, max) {
  if (isBlank(env[name])) return null;
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}="${env[name]}": expected a number between ${min} and ${max}.`);
  }
  return value;
}

function readList(env, name, fallback) {
  if (isBlank(env[name])) return fallback;
  return String(env[name])
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function clean(value, fallback = '') {
  return isBlank(value) ? fallback : String(value).trim();
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

/**
 * Builds the immutable runtime configuration from environment variables.
 * Throws a readable Error on invalid values so a bad deploy fails fast.
 */
function loadConfig(env = process.env) {
  const nodeEnv = clean(env.NODE_ENV, 'development');
  const provider = clean(env.AI_PROVIDER, 'anthropic').toLowerCase();
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`Invalid AI_PROVIDER="${env.AI_PROVIDER}": use "anthropic" or "openai".`);
  }

  const providerSettings =
    provider === 'anthropic'
      ? {
          model: clean(env.ANTHROPIC_MODEL, 'claude-sonnet-5-5'),
          baseUrl: stripTrailingSlash(clean(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')),
        }
      : {
          model: clean(env.OPENAI_MODEL),
          baseUrl: stripTrailingSlash(clean(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')),
        };
  const apiKey = provider === 'anthropic' ? clean(env.ANTHROPIC_API_KEY) : clean(env.OPENAI_API_KEY);

  const ai = {
    provider,
    ...providerSettings,
    configured: Boolean(apiKey && providerSettings.model),
    maxTokens: readInt(env, 'AI_MAX_TOKENS', 16000, 1000, 64000),
    timeoutMs: readInt(env, 'AI_TIMEOUT_MS', 150000, 1000, 600000),
    maxHttpRetries: readInt(env, 'AI_MAX_HTTP_RETRIES', 2, 0, 5),
    maxAttempts: readInt(env, 'AI_MAX_ATTEMPTS', 2, 1, 4),
    temperature: readOptionalNumber(env, 'AI_TEMPERATURE', 0, 2),
  };
  // Keep the secret out of JSON.stringify(config) and accidental logging.
  Object.defineProperty(ai, 'apiKey', { value: apiKey, enumerable: false });

  const auth = {};
  Object.defineProperty(auth, 'apiKey', { value: clean(env.FORGE_API_KEY), enumerable: false });
  auth.required = Boolean(auth.apiKey);

  return {
    env: nodeEnv,
    isProduction: nodeEnv === 'production',
    port: readInt(env, 'PORT', 3000, 1, 65535),
    host: clean(env.HOST, '0.0.0.0'),
    logLevel: clean(env.LOG_LEVEL, 'info'),
    ai,
    auth,
    cors: { origins: readList(env, 'CORS_ORIGINS', ['*']) },
    proxy: { hops: readInt(env, 'TRUST_PROXY_HOPS', 0, 0, 5) },
    rateLimit: {
      windowMs: readInt(env, 'RATE_LIMIT_WINDOW_MS', 60000, 1000, 3600000),
      max: readInt(env, 'RATE_LIMIT_MAX', 60, 1, 100000),
      generateMax: readInt(env, 'RATE_LIMIT_GENERATE_MAX', 8, 1, 100000),
    },
    limits: {
      maxBodyBytes: readInt(env, 'MAX_BODY_BYTES', 512 * 1024, 1024, 10 * 1024 * 1024),
      maxPromptChars: readInt(env, 'MAX_PROMPT_CHARS', 4000, 50, 20000),
      maxScripts: readInt(env, 'MAX_SCRIPTS', 20, 1, 40),
      maxConcurrentGenerations: readInt(env, 'MAX_CONCURRENT_GENERATIONS', 3, 1, 50),
    },
  };
}

module.exports = { loadConfig, loadDotEnv };
