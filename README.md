# Chatre API

Vercel serverless backend for **Chatre**: Firestore-persisted threads/workspaces, real command execution against a materialized sandbox, and **SSE streaming agent** runs that call your Cloudflare Workers AI chat endpoint.

Keep this repo at **`/home/akani/Documents/chatre-api`** (sibling to `chatre1`). Deploy independently with Vercel.

## Stack

- Vercel Serverless Functions (`api/*.js`) — hard cap: keep at ≤12 files
- Firebase Admin → **Firestore** project `re-el-eed0d`
- Cloudflare Worker URL for LLM (`CHATRE_WORKER_URL`)
- Commands run in ephemeral `/tmp` (allowlisted), optionally **Vercel Sandbox**

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Public health |
| GET | `/api/health?auth=1` | Authenticated ping → Connected / Unauthorized |
| GET/POST/PATCH/DELETE | `/api/threads` | Threads + messages |
| GET/POST/DELETE | `/api/workspace` | Workspace files (`?action=export` for ZIP payload) |
| POST | `/api/exec` | Run allowlisted commands |
| POST | `/api/agent` | Streaming (SSE) or JSON agent loop (token deltas per step) |
| GET/PATCH | `/api/me` | User profile + defaults; `?action=byok` for BYOK keys; `?action=connectors` for GitHub/Vercel/Supabase/Firebase |
| GET | `/api/models` | Merged Chatre + BYOK model catalog for the signed-in user |

**Auth**

- **Users:** `Authorization: Bearer <Firebase ID token>` (email/password or Google via Firebase Auth). Threads/workspaces are scoped by `userId`.
- **Service:** `Authorization: Bearer <CHATRE_API_TOKEN>` or `x-chatre-key` — companion / admin only (not for listing user threads).

**BYOK:** set `BYOK_ENCRYPTION_KEY` (32+ byte secret). Keys are AES-256-GCM encrypted in Firestore; API never returns plaintext after save. Providers: OpenRouter, Anthropic, OpenAI, Google. Default models remain Chatre Workers AI (`@cf/...`).

**Integrations:** same encryption key stores user connectors under `users/{uid}/secrets/connectors` (github, vercel, supabase, firebase PATs/tokens). Agent tools: `list_connectors`, `connector_status`, `connector_request` (host-allowlisted HTTPS only). Never returns plaintext tokens.

## Firestore layout

```
sites/chatre/
  users/{uid}
  users/{uid}/secrets/byok
  users/{uid}/secrets/connectors
  threads/{threadId}          # + userId
  threads/{threadId}/messages/{messageId}
  workspaces/{workspaceId}    # + userId
  workspaces/{workspaceId}/files/{base64url(path)}
```

**Rules:** `firestore.rules` denies all client access to `sites/chatre/**` (Admin SDK only). Publish in Firebase Console → Firestore → Rules.

## Setup

1. Create a Firebase **service account** with Firestore access for `re-el-eed0d`.
2. Copy `.env.example` → `.env.local` and fill required vars.
3. Verify before deploy:

```bash
cd chatre-api
npm install
npm run check-env   # verifies CHATRE_API_TOKEN, Firebase, CHATRE_WORKER_URL, rules
```

4. Local / deploy:

```bash
npm start           # http://localhost:8080
npx vercel          # predeploy runs check-env
```

## Optional: Vercel Sandbox

For untrusted `npm` / `git` outside the `/tmp` allowlist:

```bash
npm install @vercel/sandbox
# .env.local / Vercel env:
USE_VERCEL_SANDBOX=1
VERCEL_TOKEN=...
VERCEL_TEAM_ID=...
VERCEL_PROJECT_ID=...
```

When sandbox is missing or fails, the agent falls back to the `/tmp` allowlist runner.

## Agent quality (built-in)

- **Universal computer-use** — browser_* tools (via Worker Browser Rendering), http_request, shell, files, git
- **Token streaming** inside each agent step (Worker SSE → API SSE `type: token`)
- **Structured tools** (JSON schema / function calls via Worker) with markdown ```tool fallback
- **Auto skill routing** (coding / design / web_designs / dogfood / debugging / …) without `use_skill`
- **Tool-result summarization** + context compression for long builds
- **Checkpoints + Resume** — after each tool; soft time budget emits `interrupted`; POST `/api/agent` with `{ resume: true, threadId }`
- **Server diffs** — `previousContent` on writes; `GET /api/workspace?action=diff&id=&path=`
- **Usage history** — `lastUsage` + `usageHistory` on each thread
- Optional **Vercel Sandbox** with post-command file re-collect into Firestore


## Wire the Chatre UI

```js
localStorage.setItem("chatre_api_base", "https://chatre-api.vercel.app");
localStorage.setItem("chatre_api_key", "YOUR_CHATRE_API_TOKEN");
location.reload();
```

Paste the same token into the toolbar API key field — status badge shows **Connected** or **Unauthorized**.

## Security

- Never put the Firebase **service account** in the static site.
- Apply `firestore.rules` so clients cannot read/write `sites/chatre/**`.
- Command execution is allowlisted (or isolated via Sandbox when enabled).


## Enterprise delivery

- **Done proof** on agent `done` events (`proof` + `audit` summary); full audit via `GET /api/threads?id=…&action=audit`
- **Acceptance tests** in PLAN.md + briefing; hard gates for build/debug (preview required)
- **Role model routing** via `CHATRE_MODEL_*` env vars; spend cap `CHATRE_RUN_TOKEN_BUDGET`
- **Golden evals:** `npm run golden-eval` (also on `predeploy`)
- Secrets redacted in run logs / SSE emits
