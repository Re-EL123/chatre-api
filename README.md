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

Auth: `Authorization: Bearer <CHATRE_API_TOKEN>` or `x-chatre-key: <CHATRE_API_TOKEN>`.

## Firestore layout

```
sites/chatre/
  threads/{threadId}
  threads/{threadId}/messages/{messageId}
  workspaces/{workspaceId}
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

- **Token streaming** inside each agent step (Worker SSE → API SSE `type: token`)
- **Auto skill routing** (coding / git / documents / …) without `use_skill`
- **Tool-result summarization** + context compression for long builds
- **Usage** on `thinking` / `text` / `done` events (`steps`, `toolsUsed`, token estimates)

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
