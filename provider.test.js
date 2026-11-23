'use strict';

/**
 * Exercises the real provider code (request building, retries, timeouts, error
 * mapping, response parsing) against a local HTTP server that imitates the wire
 * format of the Anthropic and OpenAI-compatible APIs. It does NOT call the real
 * services, so it cannot prove those services behave as imitated.
 */

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createAnthropicProvider, createOpenAICompatProvider } = require('../src/services/aiProvider');
const { ClientAbortedError } = require('../src/utils/errors');
const { VALID_OUTPUT } = require('./helpers');

async function startUpstream(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null });
      handler(req, res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function anthropicConfig(baseUrl, overrides = {}) {
  return {
    provider: 'anthropic',
    apiKey: 'sk-ant-test',
    model: 'test-model',
    baseUrl,
    maxTokens: 4000,
    timeoutMs: 5000,
    maxHttpRetries: 1,
    retryBaseDelayMs: 1,
    temperature: null,
    ...overrides,
  };
}

function openaiConfig(baseUrl, overrides = {}) {
  return { ...anthropicConfig(baseUrl), provider: 'openai', apiKey: 'sk-oa-test', ...overrides };
}

const CALL = { system: 'SYSTEM PROMPT', user: 'USER MESSAGE' };

const anthropicSuccess = (input = VALID_OUTPUT) => ({
  model: 'test-model-resolved',
  stop_reason: 'tool_use',
  usage: { input_tokens: 111, output_tokens: 222 },
  content: [
    { type: 'text', text: 'thinking' },
    { type: 'tool_use', id: 'toolu_1', name: 'submit_roblox_project', input },
  ],
});

test('anthropic: builds the right request and parses the forced tool call', async () => {
  const upstream = await startUpstream((_req, res) => reply(res, 200, anthropicSuccess()));
  try {
    const provider = createAnthropicProvider(anthropicConfig(upstream.baseUrl, { temperature: 0.3 }));
    const result = await provider.generate(CALL);

    assert.deepEqual(result.output, VALID_OUTPUT);
    assert.deepEqual(result.usage, { inputTokens: 111, outputTokens: 222 });
    assert.equal(result.model, 'test-model-resolved');

    const [request] = upstream.requests;
    assert.equal(request.url, '/v1/messages');
    assert.equal(request.headers['x-api-key'], 'sk-ant-test');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.body.model, 'test-model');
    assert.equal(request.body.max_tokens, 4000);
    assert.equal(request.body.temperature, 0.3);
    assert.equal(request.body.system, 'SYSTEM PROMPT');
    assert.deepEqual(request.body.messages, [{ role: 'user', content: 'USER MESSAGE' }]);
    assert.deepEqual(request.body.tool_choice, { type: 'tool', name: 'submit_roblox_project' });
    assert.equal(request.body.tools[0].name, 'submit_roblox_project');
    assert.deepEqual(request.body.tools[0].input_schema.required.slice(0, 3), ['projectName', 'summary', 'scripts']);
  } finally {
    await upstream.close();
  }
});

test('anthropic: omits temperature unless configured', async () => {
  const upstream = await startUpstream((_req, res) => reply(res, 200, anthropicSuccess()));
  try {
    await createAnthropicProvider(anthropicConfig(upstream.baseUrl)).generate(CALL);
    assert.equal('temperature' in upstream.requests[0].body, false);
  } finally {
    await upstream.close();
  }
});

test('anthropic: token-limit stop and missing tool call are reported as retryable output errors', async () => {
  const upstream = await startUpstream((_req, res, n) =>
    n === 1
      ? reply(res, 200, { ...anthropicSuccess({}), stop_reason: 'max_tokens' })
      : reply(res, 200, { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }),
  );
  try {
    const provider = createAnthropicProvider(anthropicConfig(upstream.baseUrl));
    const truncated = await provider.generate(CALL);
    assert.equal(truncated.output, null);
    assert.match(truncated.outputError, /cut off/);

    const noTool = await provider.generate(CALL);
    assert.equal(noTool.output, null);
    assert.match(noTool.outputError, /structured output/);
  } finally {
    await upstream.close();
  }
});

test('anthropic: auth failure maps to AI_AUTH_FAILED without retrying or leaking details', async () => {
  const upstream = await startUpstream((_req, res) =>
    reply(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-test' } }),
  );
  const logged = [];
  try {
    const provider = createAnthropicProvider(anthropicConfig(upstream.baseUrl), {
      warn: (message, fields) => logged.push({ message, fields }),
    });
    await assert.rejects(provider.generate(CALL), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, 'AI_AUTH_FAILED');
      assert.ok(!err.message.includes('sk-ant-test'));
      return true;
    });
    assert.equal(upstream.requests.length, 1, 'auth errors are not retried');
    assert.ok(!JSON.stringify(logged).includes('sk-ant-test'), 'upstream auth text is never logged');
  } finally {
    await upstream.close();
  }
});

test('anthropic: 429 is retried (honouring Retry-After) and then succeeds', async () => {
  const upstream = await startUpstream((_req, res, n) =>
    n === 1
      ? reply(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '0' })
      : reply(res, 200, anthropicSuccess()),
  );
  try {
    const result = await createAnthropicProvider(anthropicConfig(upstream.baseUrl)).generate(CALL);
    assert.deepEqual(result.output, VALID_OUTPUT);
    assert.equal(upstream.requests.length, 2);
  } finally {
    await upstream.close();
  }
});

test('anthropic: persistent 429 maps to 503 AI_RATE_LIMITED; persistent 5xx maps to 502', async () => {
  const limited = await startUpstream((_req, res) => reply(res, 429, { error: { message: 'x' } }, { 'retry-after': '0' }));
  const broken = await startUpstream((_req, res) => reply(res, 529, { error: { message: 'overloaded' } }));
  try {
    await assert.rejects(createAnthropicProvider(anthropicConfig(limited.baseUrl)).generate(CALL), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'AI_RATE_LIMITED');
      assert.ok(err.headers['Retry-After']);
      return true;
    });
    assert.equal(limited.requests.length, 2, 'initial try plus one retry');

    await assert.rejects(createAnthropicProvider(anthropicConfig(broken.baseUrl)).generate(CALL), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, 'AI_UPSTREAM_ERROR');
      return true;
    });
    assert.equal(broken.requests.length, 2);
  } finally {
    await limited.close();
    await broken.close();
  }
});

test('anthropic: 404 and 400 map to dedicated codes', async () => {
  const notFound = await startUpstream((_req, res) => reply(res, 404, { error: { message: 'model: nope' } }));
  const rejected = await startUpstream((_req, res) => reply(res, 400, { error: { message: 'bad' } }));
  try {
    await assert.rejects(createAnthropicProvider(anthropicConfig(notFound.baseUrl)).generate(CALL), {
      code: 'AI_MODEL_NOT_FOUND',
    });
    await assert.rejects(createAnthropicProvider(anthropicConfig(rejected.baseUrl)).generate(CALL), {
      code: 'AI_REQUEST_REJECTED',
    });
  } finally {
    await notFound.close();
    await rejected.close();
  }
});

test('anthropic: unreadable 200 response maps to AI_BAD_RESPONSE', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not json</html>');
  });
  try {
    await assert.rejects(createAnthropicProvider(anthropicConfig(upstream.baseUrl)).generate(CALL), {
      code: 'AI_BAD_RESPONSE',
    });
  } finally {
    await upstream.close();
  }
});

test('timeouts map to 504 AI_TIMEOUT and are not retried', async () => {
  const upstream = await startUpstream(() => {
    /* never responds */
  });
  try {
    const provider = createAnthropicProvider(anthropicConfig(upstream.baseUrl, { timeoutMs: 150, maxHttpRetries: 3 }));
    await assert.rejects(provider.generate(CALL), (err) => {
      assert.equal(err.status, 504);
      assert.equal(err.code, 'AI_TIMEOUT');
      return true;
    });
    assert.equal(upstream.requests.length, 1);
  } finally {
    await upstream.close();
  }
});

test('unreachable upstream maps to 502 AI_UNREACHABLE', async () => {
  const upstream = await startUpstream(() => {});
  const { baseUrl } = upstream;
  await upstream.close();
  await assert.rejects(createAnthropicProvider(anthropicConfig(baseUrl)).generate(CALL), {
    code: 'AI_UNREACHABLE',
  });
});

test('client abort stops the provider call with ClientAbortedError', async () => {
  const upstream = await startUpstream(() => {
    /* never responds */
  });
  try {
    const controller = new AbortController();
    const provider = createAnthropicProvider(anthropicConfig(upstream.baseUrl, { timeoutMs: 10000 }));
    const pending = provider.generate({ ...CALL, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (err) => err instanceof ClientAbortedError);
  } finally {
    await upstream.close();
  }
});

test('openai-compatible: request shape and JSON parsing (including fenced JSON)', async () => {
  const upstream = await startUpstream((_req, res, n) =>
    reply(res, 200, {
      model: 'oa-model',
      usage: { prompt_tokens: 5, completion_tokens: 7 },
      choices: [
        {
          finish_reason: 'stop',
          message: { content: n === 1 ? JSON.stringify(VALID_OUTPUT) : `\`\`\`json\n${JSON.stringify(VALID_OUTPUT)}\n\`\`\`` },
        },
      ],
    }),
  );
  try {
    const provider = createOpenAICompatProvider(openaiConfig(upstream.baseUrl));
    const first = await provider.generate(CALL);
    assert.deepEqual(first.output, VALID_OUTPUT);
    assert.deepEqual(first.usage, { inputTokens: 5, outputTokens: 7 });
    assert.deepEqual((await provider.generate(CALL)).output, VALID_OUTPUT);

    const [request] = upstream.requests;
    assert.equal(request.url, '/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer sk-oa-test');
    assert.equal(request.body.model, 'test-model');
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    assert.equal(request.body.messages[0].role, 'system');
    assert.match(request.body.messages[0].content, /^SYSTEM PROMPT/);
    assert.match(request.body.messages[0].content, /JSON Schema/);
    assert.equal(request.body.messages[1].content, 'USER MESSAGE');
  } finally {
    await upstream.close();
  }
});

test('openai-compatible: length finish and non-JSON content are retryable output errors', async () => {
  const upstream = await startUpstream((_req, res, n) =>
    reply(res, 200, {
      choices:
        n === 1
          ? [{ finish_reason: 'length', message: { content: '{"projectName":' } }]
          : [{ finish_reason: 'stop', message: { content: 'Sure! Here is a game.' } }],
    }),
  );
  try {
    const provider = createOpenAICompatProvider(openaiConfig(upstream.baseUrl));
    const truncated = await provider.generate(CALL);
    assert.equal(truncated.output, null);
    assert.match(truncated.outputError, /cut off/);

    const notJson = await provider.generate(CALL);
    assert.equal(notJson.output, null);
    assert.match(notJson.outputError, /valid JSON/);
  } finally {
    await upstream.close();
  }
});
