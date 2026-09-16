'use strict';

/**
 * Chatre Secret Stack — Cursor-class three-layer architecture
 * implemented WITHOUT exceeding 12 serverless API functions.
 */

const { ROUTES, MAX_API_FUNCTIONS } = require('./api-surface');

const LAYERS = [
  {
    id: 1,
    name: 'Client IDE',
    role: 'UI, filesystem view, diffs, diagnostics, open tabs',
    surfaces: [
      'chatre1/public/panels.js',
      'chatre1/public/ide-context.js',
      'chatre1/public/understanding.js',
    ],
    gateway: null,
  },
  {
    id: 2,
    name: 'Context Engine',
    role: 'Structural chunking, merkle index, hybrid BM25+dense+rg (RRF), Priompt packing',
    surfaces: [
      'chatre-api/lib/context-rag.js',
      'chatre-api/lib/embed.js',
      'chatre-api/lib/context-cache.js',
      'chatre-api/lib/ast-parser.js',
      'chatre-api/lib/import-graph.js',
    ],
    gateway: '/api/workspace?action=index|context',
  },
  {
    id: 3,
    name: 'Cognitive & Execution',
    role: 'Plan → understand → execute → critic → verify; model routing; worktrees; MCP tools',
    surfaces: [
      'chatre-api/lib/agent.js',
      'chatre-api/lib/mcp-client.js',
      'chatre-api/lib/understanding.js',
      'chatre-api/lib/model-routing.js',
      'chatre-api/lib/critic.js',
      'chatre-api/lib/verify-loop.js',
      'chatre-api/lib/worktree-sandbox.js',
    ],
    gateway: '/api/agent + /api/chat modes + /api/exec',
  },
];

function describe() {
  return {
    name: 'Chatre Secret Stack',
    maxApiFunctions: MAX_API_FUNCTIONS,
    routesUsed: ROUTES.length,
    headroom: MAX_API_FUNCTIONS - ROUTES.length,
    routes: ROUTES.slice(),
    layers: LAYERS,
    protections: [
      'Plan mode + intent contract before mutating',
      'Strict unified diffs via previousContent / showDiff',
      'Isolated git worktrees (workspace?action=worktree)',
      'Runtime verify loop after writes (preview/tests)',
      'consistent_delivery skill pinned on delivery tasks',
    ],
  };
}

module.exports = { LAYERS, describe };
