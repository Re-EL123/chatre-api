'use strict';

/**
 * Workspace import/dependency graph built from AST import edges.
 * Used by resolve_symbol + view_import_graph tools and optional context injection.
 */

const path = require('path');
const AstParser = require('./ast-parser');

const SKIP_PATH =
  /(?:^|\/)(?:node_modules|\.git|\.next|dist|build|coverage|\.cache|vendor)(?:\/|$)/i;

const CODE_EXT =
  /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte)$/i;

const RESOLVE_EXTS = [
  '',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.json',
  '/index.js',
  '/index.ts',
  '/index.tsx',
  '/index.jsx',
  '.py',
];

function normalizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

function dirnameOf(filePath) {
  const n = normalizePath(filePath);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

function joinPath(base, rel) {
  const parts = normalizePath(base).split('/').filter(Boolean);
  const segs = normalizePath(rel).split('/');
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') parts.pop();
    else parts.push(s);
  }
  return '/' + parts.join('/');
}

function resolveImport(fromPath, source, files) {
  const spec = String(source || '').trim();
  if (!spec) return { resolved: null, external: true, source: spec };
  // Absolute-ish package / URL / bare specifier
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    return { resolved: null, external: true, source: spec };
  }
  const base = dirnameOf(fromPath);
  const targetBase = spec.startsWith('/')
    ? normalizePath(spec)
    : joinPath(base, spec);
  const map = files || {};
  for (const ext of RESOLVE_EXTS) {
    let cand = targetBase + ext;
    // workspace keys may or may not start with /
    const variants = [cand, cand.replace(/^\//, ''), '/' + cand.replace(/^\//, '')];
    for (const v of variants) {
      const f = map[v];
      if (f && f.type === 'file') {
        return { resolved: normalizePath(v), external: false, source: spec };
      }
    }
  }
  return { resolved: null, external: false, source: spec, unresolved: true };
}

/**
 * Build directed import graph.
 * @returns {{ nodes: object[], edges: object[], byPath: object, symbols: object }}
 */
function buildImportGraph(files, opts) {
  const o = opts || {};
  const map = files && typeof files === 'object' ? files : {};
  const maxFiles = Math.min(Math.max(Number(o.maxFiles) || 400, 20), 2000);
  const nodes = Object.create(null);
  const edges = [];
  const symbols = Object.create(null); // name -> [{path,line,kind}]
  let count = 0;

  const paths = Object.keys(map).sort();
  for (const filePath of paths) {
    if (SKIP_PATH.test(filePath) || !CODE_EXT.test(filePath)) continue;
    const f = map[filePath];
    if (!f || f.type !== 'file' || f.encoding === 'base64') continue;
    const content = String(f.content || '');
    if (!content || content.length > 400000) continue;
    count += 1;
    if (count > maxFiles) break;

    const np = normalizePath(filePath);
    if (!nodes[np]) {
      nodes[np] = { id: np, path: np, kind: 'file', imports: 0, importers: 0 };
    }

    const parsed = AstParser.parseFileSync(filePath, content);
    (parsed.outline || []).forEach((sym) => {
      if (!sym.name) return;
      if (!symbols[sym.name]) symbols[sym.name] = [];
      symbols[sym.name].push({
        name: sym.name,
        path: np,
        line: sym.line,
        endLine: sym.endLine || sym.line,
        kind: sym.kind,
        preview: sym.preview || '',
      });
    });

    (parsed.imports || []).forEach((imp) => {
      const res = resolveImport(np, imp.source, map);
      const toId = res.resolved || 'ext:' + imp.source;
      if (!nodes[toId]) {
        nodes[toId] = {
          id: toId,
          path: res.resolved || null,
          kind: res.external ? 'external' : res.unresolved ? 'unresolved' : 'file',
          source: imp.source,
          imports: 0,
          importers: 0,
        };
      }
      edges.push({
        from: np,
        to: toId,
        kind: imp.kind || 'import',
        line: imp.line || null,
        source: imp.source,
      });
      nodes[np].imports += 1;
      nodes[toId].importers += 1;
    });
  }

  return {
    builtAt: new Date().toISOString(),
    fileCount: count,
    nodeCount: Object.keys(nodes).length,
    edgeCount: edges.length,
    nodes: Object.keys(nodes).map((k) => nodes[k]),
    edges,
    byPath: nodes,
    symbols,
    engine: 'chatre-import-graph-v1',
  };
}

function neighbors(graph, filePath, direction, depth) {
  const np = normalizePath(filePath);
  const maxDepth = Math.min(Math.max(Number(depth) || 1, 1), 5);
  const dir = String(direction || 'both').toLowerCase();
  const seen = new Set([np]);
  const outEdges = [];
  const outNodes = new Set([np]);
  let frontier = [np];

  for (let d = 0; d < maxDepth; d++) {
    const next = [];
    for (const from of frontier) {
      for (const e of graph.edges || []) {
        let match = null;
        if ((dir === 'imports' || dir === 'both') && e.from === from) match = e;
        if ((dir === 'importers' || dir === 'both') && e.to === from) match = e;
        if (!match) continue;
        outEdges.push(match);
        const other = match.from === from ? match.to : match.from;
        outNodes.add(other);
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  const byPath = graph.byPath || {};
  return {
    path: np,
    direction: dir,
    depth: maxDepth,
    nodes: [...outNodes].map((id) => byPath[id] || { id, kind: 'unknown' }),
    edges: outEdges,
  };
}

function resolveSymbol(graph, symbol, opts) {
  const o = opts || {};
  const name = String(symbol || '').trim();
  if (!name) return { ok: false, error: 'symbol required', matches: [] };
  const all = (graph && graph.symbols && graph.symbols[name]) || [];
  let matches = all.slice();
  if (o.path) {
    const p = normalizePath(o.path);
    matches = matches.filter((m) => m.path === p || m.path.indexOf(p) >= 0);
  }
  // Case-insensitive fallback
  if (!matches.length && graph && graph.symbols) {
    const lower = name.toLowerCase();
    Object.keys(graph.symbols).forEach((k) => {
      if (k.toLowerCase() === lower) {
        matches = matches.concat(graph.symbols[k]);
      }
    });
  }
  return {
    ok: true,
    symbol: name,
    count: matches.length,
    matches: matches.slice(0, Math.min(Number(o.max) || 40, 100)),
  };
}

/** Soft in-process cache keyed by merkle-ish revision. */
const _cache = new Map();

function getCachedGraph(workspaceId, revision) {
  const key = String(workspaceId || '') + ':' + String(revision || 0);
  return _cache.get(key) || null;
}

function setCachedGraph(workspaceId, revision, graph) {
  const key = String(workspaceId || '') + ':' + String(revision || 0);
  if (_cache.size > 24) {
    const first = _cache.keys().next().value;
    _cache.delete(first);
  }
  _cache.set(key, graph);
  return graph;
}

function getOrBuild(files, opts) {
  const o = opts || {};
  const cached = getCachedGraph(o.workspaceId, o.revision);
  if (cached) return cached;
  const graph = buildImportGraph(files, o);
  if (o.workspaceId != null) setCachedGraph(o.workspaceId, o.revision, graph);
  return graph;
}

module.exports = {
  buildImportGraph,
  neighbors,
  resolveSymbol,
  resolveImport,
  getOrBuild,
  getCachedGraph,
  setCachedGraph,
};
