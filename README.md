# Chatre API

Vercel serverless backend for **Chatre**: Firestore-persisted threads/workspaces, real command execution against a materialized sandbox, and **SSE streaming agent** runs that call your Cloudflare Workers AI chat endpoint.

Keep this repo at **`/home/akani/Documents/chatre-api`** (sibling to `chatre1`). Deploy independently with Vercel.

## Stack

- Vercel Serverless Functions (`api/*.js`)
- Firebase Admin → **Firestore** project `re-el-eed0d`
- Cloudflare Worker URL for LLM (`CHATRE_WORKER_URL`)
- Commands run in ephemeral `/tmp` then sync back to Firestore

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health + backend mode |
| GET/POST/PATCH/DELETE | `/api/threads` | Threads + messages |
| GET/POST/DELETE | `/api/workspace` | Workspace files |
| POST | `/api/exec` | Run allowlisted commands |
| POST | `/api/agent` | Streaming (SSE) or JSON agent loop |

Auth: `Authorization: Bearer <CHATRE_API_TOKEN>` or `x-chatre-key: <CHATRE_API_TOKEN>`.

## Firestore layout

```
sites/chatre/
  threads/{threadId}
  threads/{threadId}/messages/{messageId}
  workspaces/{workspaceId}
  workspaces/{workspaceId}/files/{base64url(path)}
```

## Setup

1. Create a Firebase **service account** with Firestore access for `re-el-eed0d`.
2. Copy `.env.example` → `.env.local` and fill:

```bash
CHATRE_API_TOKEN=...
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
FIREBASE_PROJECT_ID=re-el-eed0d
SITE_ID=chatre
CHATRE_WORKER_URL=https://YOUR_CHATRE_WORKER.workers.dev
CHATRE_WORKER_SECRET=...
```

3. Install & run locally:

```bash
cd chatre-api
npm install
npm start
# → http://localhost:8080
```

4. Deploy:

```bash
npx vercel
```

## Wire the Chatre UI

```js
localStorage.setItem("chatre_api_base", "https://YOUR_CHATRE_API.vercel.app");
localStorage.setItem("chatre_api_key", "YOUR_CHATRE_API_TOKEN");
location.reload();
```

## Security

- Never put the Firebase **service account** in the static site.
- Apply `firestore.rules` so clients cannot write `sites/chatre/**` (Admin SDK only).
- Command execution is allowlisted and blocks dangerous shell metacharacters.
