# Forge AI Backend

Node.js backend that turns natural-language prompts into Roblox Luau scripts and returns them as structured JSON for your Studio Lite GUI to install. It does **not** touch Roblox Studio itself: it returns script names, types, install locations and full source, and your frontend decides what to do with them.

- **Zero npm dependencies.** Only Node's built-in `http`, `fetch` and `node:test`. There is nothing to install and nothing to go stale.
- **Requires Node.js 20.12 or newer** (22 recommended).
- **AI providers:** Anthropic (default) or any OpenAI-compatible chat API.

## Project structure

```
forge-ai-backend/
├── package.json
├── render.yaml                  # optional one-click Render blueprint
├── .env.example                 # copy to .env locally (never commit .env)
├── .gitignore
├── README.md
├── src/
│   ├── server.js                # entry point: config, listen, graceful shutdown
│   ├── app.js                   # request pipeline: CORS, rate limit, auth, body, routes, errors
│   ├── config.js                # environment -> validated config (secrets hidden from logs)
│   ├── routes/
│   │   ├── index.js             # route table
│   │   ├── generate.js          # POST /api/generate
│   │   └── health.js            # GET /api/health, GET /api/categories, GET /
│   ├── middleware/
│   │   ├── auth.js              # optional X-API-Key / Bearer check (timing-safe)
│   │   ├── body.js              # size-limited JSON body reader
│   │   ├── cors.js              # allow-list CORS
│   │   └── rateLimit.js         # in-memory per-IP rate limiter
│   ├── validation/
│   │   └── generateRequest.js   # request body validation and normalization
│   ├── services/
│   │   ├── generator.js         # prompts -> AI -> validate -> retry-with-feedback
│   │   ├── aiProvider.js        # Anthropic + OpenAI-compatible clients (timeouts, retries)
│   │   └── projectValidator.js  # checks model output: names, locations, safety lint, explorer tree
│   ├── prompts/
│   │   ├── systemPrompt.js      # Roblox engineering rules + output JSON schema
│   │   ├── categories.js        # per-system guidance (simulator, tycoon, obby, ...)
│   │   └── userMessage.js       # builds the user turn (wraps untrusted data)
│   └── utils/
│       ├── errors.js  http.js  logger.js  extractJson.js
└── tests/
    ├── helpers.js
    ├── unit.test.js             # config, validation, validator, prompts, rate limiter
    ├── api.test.js              # real HTTP server end to end
    └── provider.test.js         # provider clients vs. a local stand-in upstream
```

## Run it locally

```bash
cd forge-ai-backend
cp .env.example .env        # Windows: copy .env.example .env
# open .env and set ANTHROPIC_API_KEY=...
npm start
```

You should see a `forge-ai-backend listening` log line. Check it:

```bash
curl http://localhost:3000/api/health
```

Generate something:

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A pet simulator where players click to earn coins, hatch eggs, and rebirth","options":{"currencyName":"Coins"}}'
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/generate `
  -ContentType "application/json" `
  -Body '{"prompt":"An obby with 10 stages and checkpoints"}'
```

If you set `FORGE_API_KEY`, add `-H "X-API-Key: <your key>"`.

Run the tests (no API key needed): `npm test`

## API

### `GET /api/health`
Always public. Returns `200` with `status: "ok"`, or `status: "degraded"` plus `issues` when the AI key is missing (the server still runs, so a deploy health check passes and you can see what is wrong).

### `GET /api/categories`
Lists the supported systems: `simulator, tycoon, obby, pets, shop, currency, rebirth, leaderboard, combat, gui`.

### `POST /api/generate`
Headers: `Content-Type: application/json` (and `X-API-Key` if enabled).

| Field | Type | Notes |
|---|---|---|
| `prompt` | string, required | 10 to 4000 characters |
| `categories` | string[] | Optional. If omitted, categories are detected from the prompt |
| `options.currencyName` | string | e.g. `"Coins"` |
| `options.includeGui` | boolean | Default `true` |
| `options.maxScripts` | integer | 1 to 20, default 12 |
| `existingScripts` | array | Optional, up to 10 of `{name, scriptType, location, source}`. Send the scripts already in the project so follow-up prompts extend them instead of duplicating them |

Success (`200`):

```json
{
  "success": true,
  "requestId": "…",
  "data": {
    "projectName": "Pet Simulator",
    "summary": "…",
    "categories": ["simulator", "pets", "currency", "rebirth"],
    "scripts": [
      {
        "id": "ServerScriptService/Forge/CurrencyService",
        "name": "CurrencyService",
        "scriptType": "Script",
        "location": "ServerScriptService/Forge",
        "parentPath": ["ServerScriptService", "Forge"],
        "fullPath": "ServerScriptService/Forge/CurrencyService",
        "runContext": "server",
        "description": "…",
        "lineCount": 142,
        "source": "-- full Luau source"
      }
    ],
    "explorerTree": [
      { "name": "ServerScriptService", "className": "ServerScriptService", "children": [
        { "name": "Forge", "className": "Folder", "children": [
          { "name": "CurrencyService", "className": "Script", "scriptId": "ServerScriptService/Forge/CurrencyService", "children": [] }
        ]}
      ]}
    ],
    "setupInstructions": ["…"],
    "warnings": ["…"]
  },
  "meta": { "provider": "anthropic", "model": "…", "attempts": 1, "durationMs": 21000,
            "usage": { "inputTokens": 0, "outputTokens": 0 }, "generatedAt": "…" }
}
```

- `scriptType`: `Script` (server), `LocalScript` (client) or `ModuleScript`.
- `parentPath`: the exact chain of containers. The first entry is a Roblox service (or `StarterPlayer`, then `StarterPlayerScripts`/`StarterCharacterScripts`); everything after is a `Folder` your GUI should create if it does not exist.
- `explorerTree`: ready to render as an Explorer panel; leaves carry `scriptId` matching `scripts[].id`.
- `warnings`: things the creator must look at (placeholder gamepass IDs, DataStore settings, TODO markers).

Errors always have this shape, with a stable `code` to branch on:

```json
{ "success": false, "requestId": "…", "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [{ "field": "prompt", "message": "…" }] } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `EMPTY_BODY`, `BAD_URL` | Bad request |
| 401 | `UNAUTHORIZED` | Missing or wrong API key |
| 403 | `CORS_ORIGIN_DENIED` | Origin not in `CORS_ORIGINS` |
| 404 / 405 | `NOT_FOUND` / `METHOD_NOT_ALLOWED` | Wrong route or method |
| 413 | `PAYLOAD_TOO_LARGE` | Body over `MAX_BODY_BYTES` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Not `application/json` |
| 429 | `RATE_LIMITED` | Too many requests (see `Retry-After`) |
| 502 | `INVALID_MODEL_OUTPUT`, `AI_AUTH_FAILED`, `AI_MODEL_NOT_FOUND`, `AI_REQUEST_REJECTED`, `AI_UPSTREAM_ERROR`, `AI_UNREACHABLE`, `AI_BAD_RESPONSE` | AI provider problems |
| 503 | `AI_NOT_CONFIGURED`, `AI_RATE_LIMITED`, `SERVER_BUSY` | Not configured, throttled upstream, or too many simultaneous generations |
| 504 | `AI_TIMEOUT` | AI took longer than `AI_TIMEOUT_MS` |
| 500 | `INTERNAL_ERROR` | Unexpected; details are only in server logs |

## Connecting your Studio Lite frontend

```js
const API_BASE = "https://YOUR-SERVICE.onrender.com";   // or http://localhost:3000

async function generate(prompt, existingScripts = []) {
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" /*, "X-API-Key": key */ },
    body: JSON.stringify({ prompt, existingScripts }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${json.error.code}: ${json.error.message}`);
  return json.data;
}

// For each script, create the folders in parentPath (below the service), then the script:
for (const s of data.scripts) {
  studio.createScript({ parentPath: s.parentPath, name: s.name, type: s.scriptType, source: s.source });
}
```

(`studio.createScript` stands for whatever your GUI uses to add a script to its project tree.)

Notes for the frontend:

- Generation is synchronous and can take from several seconds to a couple of minutes for large projects. Show a progress state, and do not set a short fetch timeout.
- Pass the project's current scripts as `existingScripts` on follow-up prompts so shared modules (like `Remotes`) are reused instead of duplicated.
- Everything is created in code (RemoteEvents, GUIs, tycoon plots, obby courses), so installing the scripts is enough; no manual Studio work is required beyond what `setupInstructions` lists.

## Environment variables

Set these in `.env` locally, or in your host's dashboard when deployed. `.env.example` lists all of them.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | **Secret.** Required when `AI_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model to use |
| `AI_PROVIDER` | `anthropic` | `anthropic` or `openai` (OpenAI-compatible) |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | none / none / OpenAI URL | For `AI_PROVIDER=openai` |
| `FORGE_API_KEY` | empty (auth off) | Optional shared secret clients send as `X-API-Key` |
| `CORS_ORIGINS` | `*` | Comma-separated allowed frontend origins. **Set this in production** |
| `TRUST_PROXY_HOPS` | `0` | Set `1` behind one reverse proxy (Render) so rate limits use real client IPs |
| `AI_MAX_TOKENS` | `16000` | Output cap. Too low truncates big projects |
| `AI_TIMEOUT_MS` | `150000` | Per-request AI timeout |
| `RATE_LIMIT_GENERATE_MAX` | `8` | Generations per IP per window (`RATE_LIMIT_WINDOW_MS`, default 60 s) |
| `MAX_CONCURRENT_GENERATIONS` | `3` | Simultaneous AI calls (protects your spend) |
| `PORT` | `3000` | Hosts like Render set this for you |

API keys are only ever read from environment variables, are excluded from `JSON.stringify(config)`, are never logged, and are never returned by any endpoint.

## Deploy for free on Render

Render's free web service tier runs a plain Node app like this one at no cost. Hosting is free; **AI usage is not**: Anthropic's API bills per token. To use a provider that has a free tier, set `AI_PROVIDER=openai` with that provider's base URL, model and key (for example OpenRouter or Groq; check their current free-tier terms, and expect Luau quality to vary by model).

1. **Put the code on GitHub.** In the project folder: `git init`, `git add .`, `git commit -m "Forge AI backend"`, then create an empty GitHub repo and push. `.env` is git-ignored, so your key is not uploaded.
2. **Create the service.** In the Render dashboard click **New**, choose **Web Service**, and connect the repo.
3. **Settings:**
   - Runtime/Language: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
   - Health check path (Advanced): `/api/health`
4. **Environment variables** (Environment tab):
   - `ANTHROPIC_API_KEY` = your key
   - `CORS_ORIGINS` = the origin your Studio Lite GUI is served from, e.g. `https://my-forge-ui.example.com`
   - `FORGE_API_KEY` = a long random string (optional but recommended)
   - `NODE_ENV` = `production`
   - `TRUST_PROXY_HOPS` = `1`
   - `NODE_VERSION` = `22` (if the build picks an older Node)
5. **Deploy**, then open `https://YOUR-SERVICE.onrender.com/api/health`. You want `"status":"ok"` and `"configured":true`.
6. Set `API_BASE` in your frontend to that URL.

Shortcut: the included `render.yaml` is a blueprint. In Render choose **New > Blueprint**, select the repo, and it prompts you for the three secret values.

**Free-tier behavior to design around** (per Render's docs):
- A free web service **spins down after 15 minutes without traffic**; the next request wakes it, which can take up to about a minute. Have your frontend call `/api/health` on load and show a "waking up the server" message.
- Free instances get **750 free instance hours per month**, and Render may restart a free service at any time.
- The filesystem is ephemeral. This backend is stateless (it stores nothing), so that does not affect it.

The app only needs Node 20.12+, a `PORT` variable and `npm start`, so it will also run on any other Node host.

## Security notes

- **A key in a browser frontend is visible.** `FORGE_API_KEY` keeps casual abuse out, but anyone who can open your GUI's JavaScript can read it. Your real protections are `CORS_ORIGINS` (blocks other websites), the per-IP rate limit, the concurrency cap, and a spend limit on your AI provider account. If the GUI has user accounts, put authentication in front of this API.
- Rate limiting is in memory: it resets on restart and is per instance. After deploying, check the `ip` field in the logs; if every request shows the same address, adjust `TRUST_PROXY_HOPS`.
- Generated scripts are checked server-side: `loadstring` and `require(<number>)` are rejected (and regenerated), and scripts are rejected if their type does not match where they would run (for example a `LocalScript` in `ServerScriptService`).
- User prompts and existing scripts are passed to the model as clearly delimited data, and the system prompt instructs the model not to follow instructions inside them. That reduces prompt-injection risk; it cannot eliminate it, so review generated code before publishing a game.

## Known limitations

- **No Luau compiler runs on the server.** The validator checks structure, placement and a few dangerous patterns, but it cannot detect Luau syntax or logic errors. Studio's Script Analysis will show those; Forge AI will not know about them.
- **Not exercised against the live AI APIs in development.** The tests run the real provider code against a local stand-in that imitates the documented request/response format. Do a first real generation after deploying and check `meta` and `warnings`.
- The result is returned in one response. Very large requests may hit a host or proxy time limit; if you see a 502/504 from the host on big prompts, lower `maxScripts`, narrow `categories`, use a faster model, or reduce `AI_MAX_TOKENS`.
- Placeholder IDs (gamepasses, developer products) are set to `0` in generated configs and flagged in `warnings`; the creator must replace them.
