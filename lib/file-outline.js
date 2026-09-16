'use strict';

/**
 * AST-lite file outline — structural symbols with line numbers for
 * view_file_outline (keeps context small vs full read_file).
 */

const ContextRag = require('./context-rag');

const OUTLINE_RES = [
  {
    kind: 'function',
    re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/,
  },
  {
    kind: 'class',
    re: /^\s*(?:export\s+)?class\s+([A-Za-z_][\w]*)/,
  },
  {
    kind: 'method',
    re: /^\s*(?:async\s+)?([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{/,
  },
  {
    kind: 'const',
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=/,
  },
  {
    kind: 'def',
    re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/,
  },
  {
    kind: 'fn',
    re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
  },
  {
    kind: 'type',
    re: /^\s*(?:export\s+)?(?:type|interface)\s+([A-Za-z_][\w]*)/,
  },
  {
    kind: 'heading',
    re: /^#{1,3}\s+(.+)$/,
  },
];

function outlineFile(path, content, opts) {
  const o = opts || {};
  const max = Math.min(200, Math.max(20, Number(o.max) || 80));
  const lines = String(content || '').split('\n');
  const items = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of OUTLINE_RES) {
      const m = line.match(rule.re);
      if (!m) continue;
      const name = String(m[1] || '').trim().slice(0, 80);
      if (!name) continue;
      // Skip anonymous-looking method noise inside objects for short lines
      if (rule.kind === 'method' && /^(if|for|while|switch|catch|function)$/.test(name)) {
        continue;
      }
      const key = rule.kind + ':' + name + ':' + (i + 1);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        kind: rule.kind,
        name,
        line: i + 1,
        preview: line.trim().slice(0, 120),
      });
      break;
    }
    if (items.length >= max) break;
  }

  // Fallback: symbol extract without lines if outline empty but file has code
  if (!items.length && String(content || '').trim()) {
    const symbols = ContextRag.extractSymbols(content, path) || [];
    symbols.slice(0, 24).forEach(function (name) {
      items.push({ kind: 'symbol', name: name, line: null, preview: name });
    });
  }

  return {
    path: String(path || ''),
    total_lines: lines.length,
    count: items.length,
    outline: items,
  };
}

module.exports = {
  outlineFile,
};
