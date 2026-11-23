'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { VALID_OUTPUT, fakeProvider, okResult, startTestServer, postGenerate, until } = require('./helpers');

const PROMPT = { prompt: 'Create a coin simulator with a shop and a leaderboard' };

async function withServer(options, fn) {
  const server = await startTestServer(options);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test('GET /api/health reports status without leaking secrets', () =>
  withServer({}, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'forge-ai-backend');
    assert.equal(body.ai.configured, true);
    assert.equal(body.ai.provider, 'anthropic');
    assert.ok(typeof body.uptimeSeconds === 'number');
    assert.ok(response.headers.get('x-request-id'));
    assert.ok(!JSON.stringify(body).includes('test-secret-key'));
  }));

test('GET /api/health is degraded when the AI key is missing', () =>
  withServer({ env: { ANTHROPIC_API_KEY: '' } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.ai.configured, false);
    assert.match(body.issues[0], /ANTHROPIC_API_KEY/);
  }));

test('GET /api/categories lists the supported systems', () =>
  withServer({}, async ({ baseUrl }) => {
    const body = await (await fetch(`${baseUrl}/api/categories`)).json();
    const ids = body.data.categories.map((category) => category.id);
    for (const id of ['simulator', 'tycoon', 'obby', 'pets', 'shop', 'currency', 'rebirth', 'leaderboard', 'combat', 'gui']) {
      assert.ok(ids.includes(id), id);
    }
  }));

test('unknown routes return 404 and wrong methods return 405 with Allow', () =>
  withServer({}, async ({ baseUrl }) => {
    const missing = await fetch(`${baseUrl}/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'NOT_FOUND');

    const wrongMethod = await fetch(`${baseUrl}/api/generate`);
    assert.equal(wrongMethod.status, 405);
    assert.match(wrongMethod.headers.get('allow'), /POST/);
    assert.equal((await wrongMethod.json()).error.code, 'METHOD_NOT_ALLOWED');
  }));

test('POST /api/generate rejects bad content types, bad JSON and invalid bodies', () =>
  withServer({}, async ({ baseUrl }) => {
    const wrongType = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(wrongType.status, 415);

    const badJson = await postGenerate(baseUrl, '{not json');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json.error.code, 'INVALID_JSON');

    const empty = await postGenerate(baseUrl, '');
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'EMPTY_BODY');

    const invalid = await postGenerate(baseUrl, { prompt: 'hi' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.success, false);
    assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');
    assert.equal(invalid.json.error.details[0].field, 'prompt');
    assert.ok(invalid.json.requestId);
  }));

test('POST /api/generate returns structured scripts', async () => {
  const provider = fakeProvider(() => okResult());
  await withServer({ provider }, async ({ baseUrl }) => {
    const { status, json } = await postGenerate(baseUrl, {
      ...PROMPT,
      options: { currencyName: 'Gems', maxScripts: 8 },
    });

    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.ok(json.requestId);
    assert.equal(json.data.projectName, 'Coin Simulator');
    assert.equal(json.data.scripts.length, 3);
    for (const item of json.data.scripts) {
      for (const key of ['name', 'scriptType', 'location', 'parentPath', 'source', 'runContext', 'fullPath']) {
        assert.ok(item[key] !== undefined, `missing ${key}`);
      }
    }
    const gui = json.data.scripts.find((item) => item.name === 'CoinGui');
    assert.equal(gui.location, 'StarterPlayer/StarterPlayerScripts/Forge');
    assert.ok(Array.isArray(json.data.explorerTree));
    assert.ok(json.data.categories.includes('simulator'));
    assert.ok(json.data.categories.includes('shop'));
    assert.ok(json.data.categories.includes('leaderboard'));
    assert.equal(json.meta.attempts, 1);
    assert.equal(json.meta.model, 'fake-model');
    assert.deepEqual(json.meta.usage, { inputTokens: 10, outputTokens: 20 });

    assert.equal(provider.calls.length, 1);
    assert.match(provider.calls[0].system, /### Shop/);
    assert.match(provider.calls[0].user, /main currency: Gems/);
    assert.match(provider.calls[0].user, /Maximum number of scripts: 8/);
  });
});

test('invalid model output is retried with feedback, then accepted', async () => {
  const provider = fakeProvider((_args, call) =>
    call === 1
      ? okResult({ ...VALID_OUTPUT, scripts: [{ ...VALID_OUTPUT.scripts[0], source: 'loadstring("x")()' }] })
      : okResult(),
  );
  await withServer({ provider }, async ({ baseUrl }) => {
    const { status, json } = await postGenerate(baseUrl, PROMPT);
    assert.equal(status, 200);
    assert.equal(json.meta.attempts, 2);
    assert.deepEqual(json.meta.usage, { inputTokens: 20, outputTokens: 40 });
    assert.equal(provider.calls.length, 2);
    assert.match(provider.calls[1].user, /previous attempt was rejected/);
    assert.match(provider.calls[1].user, /loadstring/);
  });
});

test('persistently invalid model output yields 502 INVALID_MODEL_OUTPUT', async () => {
  const provider = fakeProvider(() => okResult({ projectName: 'x', scripts: [] }));
  await withServer({ provider }, async ({ baseUrl }) => {
    const { status, json } = await postGenerate(baseUrl, PROMPT);
    assert.equal(status, 502);
    assert.equal(json.error.code, 'INVALID_MODEL_OUTPUT');
    assert.equal(provider.calls.length, 2);
  });
});

test('truncated model output is retried', async () => {
  const provider = fakeProvider((_args, call) =>
    call === 1 ? { output: null, outputError: 'cut off', usage: {}, model: 'm' } : okResult(),
  );
  await withServer({ provider }, async ({ baseUrl }) => {
    const { status, json } = await postGenerate(baseUrl, PROMPT);
    assert.equal(status, 200);
    assert.equal(json.meta.attempts, 2);
    assert.match(provider.calls[1].user, /cut off/);
  });
});

test('503 AI_NOT_CONFIGURED when the key is missing (after validation)', () =>
  withServer({ env: { ANTHROPIC_API_KEY: '' } }, async ({ baseUrl }) => {
    assert.equal((await postGenerate(baseUrl, { prompt: 'x' })).status, 400);
    const { status, json } = await postGenerate(baseUrl, PROMPT);
    assert.equal(status, 503);
    assert.equal(json.error.code, 'AI_NOT_CONFIGURED');
  }));

test('API key authentication (X-API-Key and Bearer)', () =>
  withServer({ env: { FORGE_API_KEY: 'letmein-123' } }, async ({ baseUrl }) => {
    const none = await postGenerate(baseUrl, PROMPT);
    assert.equal(none.status, 401);
    assert.equal(none.json.error.code, 'UNAUTHORIZED');

    assert.equal((await postGenerate(baseUrl, PROMPT, { 'x-api-key': 'wrong' })).status, 401);
    assert.equal((await postGenerate(baseUrl, PROMPT, { 'x-api-key': 'letmein-123' })).status, 200);
    assert.equal((await postGenerate(baseUrl, PROMPT, { authorization: 'Bearer letmein-123' })).status, 200);

    // health stays public so uptime checks work
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.auth.required, true);
  }));

test('generate rate limit returns 429 with Retry-After', () =>
  withServer({ env: { RATE_LIMIT_GENERATE_MAX: '2' } }, async ({ baseUrl }) => {
    assert.equal((await postGenerate(baseUrl, PROMPT)).status, 200);
    assert.equal((await postGenerate(baseUrl, PROMPT)).status, 200);
    const limited = await postGenerate(baseUrl, PROMPT);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  }));

test('CORS: allowed origin, denied origin and preflight', () =>
  withServer({ env: { CORS_ORIGINS: 'https://forge.example.com' } }, async ({ baseUrl }) => {
    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'https://forge.example.com' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://forge.example.com');

    const denied = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'https://evil.example.com' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${baseUrl}/api/generate`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://forge.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-API-Key/i);

    const noOrigin = await fetch(`${baseUrl}/api/health`);
    assert.equal(noOrigin.status, 200);
  }));

test('oversized bodies are rejected with 413', () =>
  withServer({ env: { MAX_BODY_BYTES: '1024' } }, async ({ baseUrl }) => {
    const { status, json } = await postGenerate(baseUrl, { prompt: 'a'.repeat(5000) });
    assert.equal(status, 413);
    assert.equal(json.error.code, 'PAYLOAD_TOO_LARGE');
  }));

test('concurrent generation cap returns 503 SERVER_BUSY', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = fakeProvider(async () => {
    await gate;
    return okResult();
  });

  await withServer({ provider, env: { MAX_CONCURRENT_GENERATIONS: '1' } }, async ({ baseUrl }) => {
    const first = postGenerate(baseUrl, PROMPT);
    await until(() => provider.calls.length === 1);

    const second = await postGenerate(baseUrl, PROMPT);
    assert.equal(second.status, 503);
    assert.equal(second.json.error.code, 'SERVER_BUSY');

    release();
    assert.equal((await first).status, 200);
    assert.equal((await postGenerate(baseUrl, PROMPT)).status, 200, 'slot is freed afterwards');
  });
});

test('client disconnect aborts the in-flight AI call', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let seenSignal;
  const provider = fakeProvider(async ({ signal }) => {
    seenSignal = signal;
    await gate;
    return okResult();
  });

  await withServer({ provider }, async ({ baseUrl }) => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PROMPT),
      signal: controller.signal,
    }).catch(() => 'aborted');

    await until(() => provider.calls.length === 1);
    assert.equal(seenSignal.aborted, false);
    controller.abort();
    assert.equal(await pending, 'aborted');
    await until(() => seenSignal.aborted === true);
    release();
  });
});

test('provider failures are mapped to safe errors', async () => {
  const { AppError } = require('../src/utils/errors');
  const provider = fakeProvider(() => {
    throw new AppError(504, 'AI_TIMEOUT', 'The AI provider took too long to respond.');
  });
  await withServer({ provider }, async ({ baseUrl }) => {
    const { status, json } = await postGenerate(baseUrl, PROMPT);
    assert.equal(status, 504);
    assert.equal(json.error.code, 'AI_TIMEOUT');
  });

  const crashing = fakeProvider(() => {
    throw new Error('secret internal detail test-secret-key');
  });
  await withServer({ provider: crashing }, async ({ baseUrl }) => {
    const { status, json } = await postGenerate(baseUrl, PROMPT);
    assert.equal(status, 500);
    assert.equal(json.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(json).includes('secret internal detail'));
  });
});
