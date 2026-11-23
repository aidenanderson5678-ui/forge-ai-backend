'use strict';

const { AppError, ClientAbortedError } = require('../utils/errors');
const { extractJsonObject } = require('../utils/extractJson');
const {
  OUTPUT_SCHEMA,
  TOOL_NAME,
  TOOL_DESCRIPTION,
  JSON_ONLY_INSTRUCTION,
} = require('../prompts/systemPrompt');

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_BACKOFF_MS = 8000;
const TRUNCATED_MESSAGE =
  'Your response was cut off at the output token limit. Return fewer or more compact scripts so the whole project fits.';

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new ClientAbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ClientAbortedError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function upstreamMessage(text) {
  try {
    const parsed = JSON.parse(text);
    const message = (parsed && parsed.error && parsed.error.message) || (parsed && parsed.message);
    if (typeof message === 'string') return message.slice(0, 300);
  } catch {
    // not JSON
  }
  return String(text).slice(0, 300);
}

function mapHttpError(status, text, retryAfter, logger) {
  // Never log upstream text for auth errors: some providers echo part of the key.
  const authError = status === 401 || status === 403;
  if (logger) {
    logger.warn('ai provider error', authError ? { status } : { status, detail: upstreamMessage(text) });
  }

  if (authError) {
    return new AppError(
      502,
      'AI_AUTH_FAILED',
      "The server's AI credentials were rejected. Contact the site administrator.",
    );
  }
  if (status === 404) {
    return new AppError(
      502,
      'AI_MODEL_NOT_FOUND',
      'The configured AI model or endpoint was not found. Contact the site administrator.',
    );
  }
  if (status === 429) {
    const seconds = Number(retryAfter);
    return new AppError(503, 'AI_RATE_LIMITED', 'The AI provider is rate limiting requests. Try again shortly.', {
      headers: { 'Retry-After': String(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 10) },
    });
  }
  if (status === 400 || status === 413 || status === 422) {
    return new AppError(502, 'AI_REQUEST_REJECTED', 'The AI provider rejected the request.');
  }
  return new AppError(502, 'AI_UPSTREAM_ERROR', 'The AI provider returned an error. Try again shortly.');
}

/**
 * POSTs JSON with a timeout, client-abort support and retry on transient errors.
 * Resolves with the raw response text of a 2xx response.
 */
async function postJson({ url, headers, body, signal, cfg, logger }) {
  const payload = JSON.stringify(body);
  const baseDelay = cfg.retryBaseDelayMs ?? 1000;

  for (let attempt = 0; ; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let status;
    let text;
    let retryAfter;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: payload,
        signal: combined,
      });
      status = response.status;
      retryAfter = response.headers.get('retry-after');
      text = await response.text();
    } catch (err) {
      if (signal && signal.aborted) throw new ClientAbortedError();
      if (timeoutSignal.aborted) {
        throw new AppError(
          504,
          'AI_TIMEOUT',
          'The AI provider took too long to respond. Try a smaller or more specific request.',
        );
      }
      if (logger) logger.warn('ai provider unreachable', { reason: err && err.name });
      throw new AppError(502, 'AI_UNREACHABLE', 'Could not reach the AI provider. Try again shortly.');
    }

    if (status >= 200 && status < 300) return text;

    if (RETRYABLE_STATUS.has(status) && attempt < cfg.maxHttpRetries) {
      const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
      const delay =
        Number.isFinite(seconds) && seconds >= 0
          ? Math.min(seconds * 1000, MAX_BACKOFF_MS)
          : Math.min(baseDelay * 2 ** attempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * 250);
      await sleep(delay, signal);
      continue;
    }

    throw mapHttpError(status, text, retryAfter, logger);
  }
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(502, 'AI_BAD_RESPONSE', 'The AI provider returned an unreadable response.');
  }
}

/**
 * Anthropic Messages API. A forced tool call guarantees schema-shaped JSON.
 * Each provider's generate() resolves to:
 *   { output, outputError?, usage: { inputTokens, outputTokens }, model }
 * `outputError` marks output the generator should retry; hard failures throw AppError.
 */
function createAnthropicProvider(cfg, logger) {
  return {
    name: 'anthropic',
    async generate({ system, user, signal }) {
      const body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: OUTPUT_SCHEMA }],
        tool_choice: { type: 'tool', name: TOOL_NAME },
      };
      if (cfg.temperature !== null && cfg.temperature !== undefined) body.temperature = cfg.temperature;

      const text = await postJson({
        url: `${cfg.baseUrl}/v1/messages`,
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body,
        signal,
        cfg,
        logger,
      });

      const data = parseJsonResponse(text);
      const usage = {
        inputTokens: (data.usage && data.usage.input_tokens) || 0,
        outputTokens: (data.usage && data.usage.output_tokens) || 0,
      };
      const model = data.model || cfg.model;

      if (data.stop_reason === 'max_tokens') {
        return { output: null, outputError: TRUNCATED_MESSAGE, usage, model };
      }

      const block = Array.isArray(data.content)
        ? data.content.find((item) => item && item.type === 'tool_use' && item.name === TOOL_NAME)
        : null;
      if (!block || block.input === null || typeof block.input !== 'object') {
        return {
          output: null,
          outputError: 'You did not return the required structured output. Call the submit tool with the full project.',
          usage,
          model,
        };
      }

      return { output: block.input, usage, model };
    },
  };
}

/** Any OpenAI-compatible /chat/completions API (OpenAI, OpenRouter, Groq, Gemini compat, ...). */
function createOpenAICompatProvider(cfg, logger) {
  return {
    name: 'openai',
    async generate({ system, user, signal }) {
      const body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        messages: [
          { role: 'system', content: `${system}\n\n${JSON_ONLY_INSTRUCTION}` },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
      };
      if (cfg.temperature !== null && cfg.temperature !== undefined) body.temperature = cfg.temperature;

      const text = await postJson({
        url: `${cfg.baseUrl}/chat/completions`,
        headers: { authorization: `Bearer ${cfg.apiKey}` },
        body,
        signal,
        cfg,
        logger,
      });

      const data = parseJsonResponse(text);
      const usage = {
        inputTokens: (data.usage && data.usage.prompt_tokens) || 0,
        outputTokens: (data.usage && data.usage.completion_tokens) || 0,
      };
      const model = data.model || cfg.model;
      const choice = Array.isArray(data.choices) ? data.choices[0] : null;

      if (choice && choice.finish_reason === 'length') {
        return { output: null, outputError: TRUNCATED_MESSAGE, usage, model };
      }

      const content = choice && choice.message ? choice.message.content : null;
      try {
        return { output: extractJsonObject(content), usage, model };
      } catch (err) {
        return {
          output: null,
          outputError: `${err.message} Reply with only the JSON object described in the instructions.`,
          usage,
          model,
        };
      }
    },
  };
}

function createProvider(aiConfig, logger) {
  return aiConfig.provider === 'anthropic'
    ? createAnthropicProvider(aiConfig, logger)
    : createOpenAICompatProvider(aiConfig, logger);
}

module.exports = { createProvider, createAnthropicProvider, createOpenAICompatProvider };
