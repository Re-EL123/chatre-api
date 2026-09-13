'use strict';

/**
 * Canonical Chatre API surface — HARD CAP: 12 top-level functions.
 * New capabilities must be actions/modes on these routes, not new files under api/.
 *
 *  1. /api/health
 *  2. /api/me
 *  3. /api/models
 *  4. /api/chat          (+ mode=chat|complete|edit)
 *  5. /api/agent
 *  6. /api/agents
 *  7. /api/threads
 *  8. /api/workspace     (+ action=index|context|repo|diagnostics|diff|file|…)
 *  9. /api/exec
 * 10. /api/companion
 *
 * Editor stack mapping:
 *  Client Layer     → public/ide-context.js + panels
 *  Context/RAG      → lib/context-rag.js + workspace?action=index|context
 *  Orchestration    → /api/chat modes + /api/agent SSE
 *  Inference        → Workers AI / BYOK via lib/llm.js
 */
module.exports = {
  MAX_API_FUNCTIONS: 12,
  ROUTES: [
    'health',
    'me',
    'models',
    'chat',
    'agent',
    'agents',
    'threads',
    'workspace',
    'exec',
    'companion',
  ],
};
