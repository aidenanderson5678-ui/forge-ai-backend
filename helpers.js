'use strict';

const http = require('node:http');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/utils/logger');
const { createGenerator } = require('../src/services/generator');
const { createApp } = require('../src/app');

/** A model output that passes validation. */
const VALID_OUTPUT = {
  projectName: 'Coin Simulator',
  summary: 'A small coin simulator.',
  scripts: [
    {
      name: 'Remotes',
      scriptType: 'ModuleScript',
      location: 'ReplicatedStorage/Forge',
      description: 'Creates and fetches RemoteEvents.',
      source: 'local Remotes = {}\nreturn Remotes\n',
    },
    {
      name: 'CurrencyService',
      scriptType: 'Script',
      location: 'ServerScriptService/Forge',
      description: 'Owns player balances.',
      source: 'local DataStoreService = game:GetService("DataStoreService")\nprint("ready")\n',
    },
    {
      name: 'CoinGui',
      scriptType: 'LocalScript',
      location: 'StarterPlayerScripts/Forge',
      description: 'Shows the coin counter.',
      source: 'local Players = game:GetService("Players")\nprint(Players.LocalPlayer)\n',
    },
  ],
  setupInstructions: ['Publish the place.'],
  warnings: [],
};

/** Test double standing in for the AI provider (the pipeline around it is real). */
function fakeProvider(responder) {
  const calls = [];
  return {
    name: 'fake',
    calls,
    async generate(args) {
      calls.push(args);
      return responder(args, calls.length);
    },
  };
}

function okResult(output = VALID_OUTPUT) {
  return { output, usage: { inputTokens: 10, outputTokens: 20 }, model: 'fake-model' };
}

async function startTestServer({ env = {}, provider } = {}) {
  const config = loadConfig({ ANTHROPIC_API_KEY: 'test-secret-key', ...env });
  const logger = createLogger({ level: 'silent' });
  const generator = createGenerator({ provider: provider || fakeProvider(() => okResult()), config, logger });
  const app = createApp({ config, logger, generator });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    async close() {
      app.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function postGenerate(baseUrl, body, headers = {}) {
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, json: await response.json() };
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

module.exports = { VALID_OUTPUT, fakeProvider, okResult, startTestServer, postGenerate, until };
