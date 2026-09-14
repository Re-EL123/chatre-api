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
 *  8. /api/workspace     (+ action=index|context|repo|diagnostics|diff|file|worktree|stack|…)
 *  9. /api/exec
 * 10. /api/companion
 *
 * Secret Stack (Cursor-class, no extra routes):
 *  Layer 1 Client IDE  → chatre1 panels + ide-context + diffs
 *  Layer 2 Context     → lib/context-rag.js via workspace?action=index|context
 *  Layer 3 Cognitive   → /api/agent + model-routing + critic + verify-loop + worktrees
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
