'use strict';

/**
 * Chatre Context Engine (Layer 2) — Priompt-style priority packing + hybrid retrieval.
 *
 * Maps Cursor's "secret stack" without new top-level API routes (≤12):
 *  - Structural chunking (AST breaks + function/class regions)
 *  - Merkle root over file content hashes (incremental freshness)
 *  - Hybrid search: BM25 + dense vectors + path/symbol boost + lexical (RRF)
 *  - Priority packing: diagnostics > selection > active > tabs > dense > rg > BM25
 *
 * Gateway: /api/workspace?action=index|context
 * Dense: lib/embed.js (hash n-grams by default; optional Workers AI / embed URL).
 */

const crypto = require('crypto');
const Embed = require('./embed');

let AstParser = null;
try {
  AstParser = require('./ast-parser');
} catch {
  AstParser = null;
}

const CODE_EXT =
  /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte|html|css|scss|md|json|yml|yaml|toml|sh|sql)$/i;

const SKIP_PATH =
  /(?:^|\/)(?:node_modules|\.git|\.next|dist|build|coverage|\.cache|vendor)(?:\/|$)/i;

/** Priority tiers for Priompt-style packing (higher = keep first). */
const PRIORITY = {
  diagnostics: 100,
  selection: 95,
  cursor: 90,
  active: 85,
  openTabs: 70,
  dense: 62,
  rg: 60,
  bm25: 50,
  recency: 40,
};

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_./+-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 48);
}

function extractSymbols(content, path) {
  const src = String(content || '');
  const out = [];
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/g,
    /\b(?:export\s+)?class\s+([A-Za-z_][\w]*)/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=/g,
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm,
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/gm,
    /^\s*(?:export\s+)?(?:type|interface)\s+([A-Za-z_][\w]*)/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      out.push(m[1]);
      if (out.length >= 40) break;
    }
  }
  const base = String(path || '')
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '');
  if (base && !/^(index|main|app|mod)$/i.test(base)) out.push(base);
  return [...new Set(out)].slice(0, 48);
}

function contentHash(content) {
  return crypto.createHash('sha1').update(String(content || ''), 'utf8').digest('hex');
}

/**
 * Find structural split points (AST outline + regex fallback) for chunking.
 */
function structuralBreaks(lines, filePath, content) {
  const breaks = [0];
  if (AstParser && filePath) {
    try {
      const astBreaks = AstParser.structuralBreakLines(filePath, content || lines.join('\n'));
      for (const line1 of astBreaks) {
        const idx = Math.max(0, Number(line1) - 1);
        if (idx > 0 && idx < lines.length) breaks.push(idx);
      }
    } catch {
      /* fall through */
    }
  }
  const re =
    /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|interface|type|impl|struct|enum)\b|^\s*(?:pub\s+)?(?:async\s+)?fn\b/;
  for (let i = 1; i < lines.length; i++) {
    if (re.test(lines[i])) breaks.push(i);
  }
  return [...new Set(breaks)].sort((a, b) => a - b);
}

function makeChunk(path, lines, start, end, opts) {
  const body = lines.slice(start, end).join('\n');
  if (!body.trim()) return null;
  const symbols = extractSymbols(body, path);
  const tokens = tokenize(body + ' ' + symbols.join(' ') + ' ' + path);
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const chunk = {
    id: path + '#' + (start + 1) + '-' + end,
    path,
    startLine: start + 1,
    endLine: end,
    symbols,
    tf,
    preview: body.slice(0, 400),
    len: body.length,
    hash: contentHash(body),
  };
  const embedOff = opts && opts.embed === false;
  if (!embedOff) {
    const text = chunk.preview + ' ' + symbols.join(' ') + ' ' + path;
    chunk.vec = Embed.toArray(Embed.embedText(text, { dim: opts && opts.dim }));
  }
  return chunk;
}

/**
 * Structural chunking with fallback to sliding windows.
 */
function chunkFile(path, content, opts) {
  return chunkFileFixed(path, content, opts);
}

/** Fixed structural chunker */
function chunkFileFixed(path, content, opts) {
  const lines = String(content || '').split('\n');
  const maxSize = (opts && opts.lines) || 80;
  const overlap = (opts && opts.overlap) || 12;
  const chunks = [];
  if (!lines.length) return chunks;

  const breaks = structuralBreaks(lines, path, content);
  const useStructural = breaks.length >= 2 && lines.length > maxSize;

  if (useStructural) {
    for (let bi = 0; bi < breaks.length; bi++) {
      let regionStart = breaks[bi];
      const regionEnd = bi + 1 < breaks.length ? breaks[bi + 1] : lines.length;
      let start = regionStart;
      while (start < regionEnd) {
        const end = Math.min(regionEnd, start + maxSize);
        const c = makeChunk(path, lines, start, end, opts);
        if (c) chunks.push(c);
        if (end >= regionEnd) break;
        start = Math.max(start + 1, end - overlap);
      }
    }
  } else {
    for (let start = 0; start < lines.length; start += Math.max(1, maxSize - overlap)) {
      const end = Math.min(lines.length, start + maxSize);
      const c = makeChunk(path, lines, start, end, opts);
      if (c) chunks.push(c);
      if (end >= lines.length) break;
    }
  }
  return chunks;
}

function merkleRoot(fileHashes) {
  const keys = Object.keys(fileHashes || {}).sort();
  if (!keys.length) return contentHash('');
  let level = keys.map((k) => contentHash(k + ':' + fileHashes[k]));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(contentHash(level[i] + level[i + 1]));
      else next.push(level[i]);
    }
    level = next;
  }
  return level[0];
}

function buildIndex(files, opts) {
  const map = files && typeof files === 'object' ? files : {};
  const chunks = [];
  const fileHashes = Object.create(null);
  const paths = Object.keys(map).sort();
  let fileCount = 0;
  const embed = !(opts && opts.embed === false);
  for (const path of paths) {
    if (SKIP_PATH.test(path) || !CODE_EXT.test(path)) continue;
    const f = map[path];
    if (!f || f.type !== 'file') continue;
    if (f.encoding === 'base64') continue;
    const content = String(f.content || '');
    if (!content || content.length > 400000) continue;
    fileCount += 1;
    fileHashes[path] = f.hash || contentHash(content);
    chunks.push(...chunkFileFixed(path, content, Object.assign({}, opts, { embed })));
    if (chunks.length > 800) break;
  }
  const df = Object.create(null);
  for (const c of chunks) {
    const seen = new Set(Object.keys(c.tf));
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }
  const root = merkleRoot(fileHashes);
  return {
    revision: (opts && opts.revision) || 0,
    builtAt: new Date().toISOString(),
    fileCount,
    chunkCount: chunks.length,
    merkleRoot: root,
    fileHashes,
    df,
    engine: 'chatre-context-v3',
    embed: embed ? 'hash' : 'off',
    dim: embed ? Embed.DEFAULT_DIM : 0,
    chunks: chunks.map((c) => ({
      id: c.id,
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      symbols: c.symbols,
      tf: c.tf,
      preview: c.preview,
      len: c.len,
      hash: c.hash,
      vec: c.vec || null,
    })),
  };
}

function scoreChunk(queryTokens, chunk, df, nDocs) {
  if (!queryTokens.length || !chunk || !chunk.tf) return 0;
  let score = 0;
  const k1 = 1.2;
  const b = 0.75;
  const avgLen = 120;
  const dl = Math.max(1, Object.values(chunk.tf).reduce((a, v) => a + v, 0));
  for (const t of queryTokens) {
    const f = chunk.tf[t] || 0;
    if (!f) continue;
    const docFreq = df[t] || 0;
    const idf = Math.log(1 + (nDocs - docFreq + 0.5) / (docFreq + 0.5));
    const tfNorm = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgLen)));
    score += idf * tfNorm;
  }
  const sym = (chunk.symbols || []).map((s) => String(s).toLowerCase());
  for (const t of queryTokens) {
    if (sym.indexOf(t) >= 0) score += 2.5;
    if (String(chunk.path || '').toLowerCase().indexOf(t) >= 0) score += 0.8;
  }
  return score;
}

function searchIndex(index, query, opts) {
  const topK = Math.min(Math.max(Number(opts && opts.topK) || 8, 1), 24);
  const qTokens = tokenize(query);
  if (!index || !Array.isArray(index.chunks) || !qTokens.length) return [];
  const nDocs = Math.max(1, index.chunks.length);
  const df = index.df || {};
  const scored = index.chunks
    .map((c) => ({ chunk: c, score: scoreChunk(qTokens, c, df, nDocs) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored.map((x) => ({
    id: x.chunk.id,
    path: x.chunk.path,
    startLine: x.chunk.startLine,
    endLine: x.chunk.endLine,
    symbols: x.chunk.symbols || [],
    score: Math.round(x.score * 1000) / 1000,
    preview: x.chunk.preview || '',
    source: 'bm25',
  }));
}

/**
 * Dense cosine search over chunk vectors.
 */
function denseSearch(index, query, opts) {
  const topK = Math.min(Math.max(Number(opts && opts.topK) || 8, 1), 24);
  if (!index || !Array.isArray(index.chunks)) return [];
  const qVec =
    (opts && opts.queryVec) ||
    Embed.embedText(String(query || ''), { dim: index.dim || Embed.DEFAULT_DIM });
  const scored = [];
  for (const c of index.chunks) {
    const v = Embed.fromArray(c.vec);
    if (!v) continue;
    const score = Embed.cosine(qVec, v);
    if (score <= 0.05) continue;
    scored.push({ chunk: c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((x) => ({
    id: x.chunk.id,
    path: x.chunk.path,
    startLine: x.chunk.startLine,
    endLine: x.chunk.endLine,
    symbols: x.chunk.symbols || [],
    score: Math.round(x.score * 1000) / 1000,
    preview: x.chunk.preview || '',
    source: 'dense',
  }));
}

/**
 * Reciprocal Rank Fusion of BM25 + dense + ripgrep-style lexical hits.
 */
function hybridSearch(index, query, opts) {
  const o = opts || {};
  const topK = Math.min(Math.max(Number(o.topK) || 10, 1), 24);
  const bm25 = searchIndex(index, query, { topK: topK * 2 });
  const lexical = Array.isArray(o.lexicalHits) ? o.lexicalHits : [];
  const dense =
    Array.isArray(o.denseHits)
      ? o.denseHits
      : o.skipDense
        ? []
        : denseSearch(index, query, { topK: topK * 2, queryVec: o.queryVec });

  const scores = Object.create(null);
  const meta = Object.create(null);
  function add(list, weight) {
    list.forEach((h, i) => {
      const key = (h.path || '') + '#' + (h.startLine || 0) + '-' + (h.endLine || 0);
      const rrf = weight / (60 + i + 1);
      scores[key] = (scores[key] || 0) + rrf;
      if (!meta[key]) meta[key] = Object.assign({}, h, { source: 'hybrid' });
      else {
        const prev = meta[key].source || '';
        if (prev !== 'hybrid') {
          meta[key].sources = [prev, h.source || 'hit'].filter(Boolean);
        }
        meta[key].source = 'hybrid';
      }
    });
  }
  add(bm25, 1.0);
  add(lexical, 1.1);
  add(dense, 1.15);

  return Object.keys(scores)
    .map((k) =>
      Object.assign({}, meta[k], {
        score: Math.round(scores[k] * 1000) / 1000,
      }),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function readSlice(files, path, startLine, endLine) {
  const f = files && files[path];
  if (!f || f.type !== 'file') return '';
  const lines = String(f.content || '').split('\n');
  const a = Math.max(0, (startLine || 1) - 1);
  const b = Math.min(lines.length, endLine || lines.length);
  return lines.slice(a, b).join('\n');
}

/**
 * Build lexical hits from a simple in-memory ripgrep-like scan (no new route).
 */
function lexicalScan(files, query, opts) {
  const q = String(query || '').trim();
  if (!q || q.length < 2) return [];
  const topK = Math.min(Math.max(Number(opts && opts.topK) || 8, 1), 24);
  const map = files || {};
  const hits = [];
  const re = (() => {
    try {
      return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch {
      return null;
    }
  })();
  if (!re) return [];
  for (const path of Object.keys(map).sort()) {
    if (SKIP_PATH.test(path) || !CODE_EXT.test(path)) continue;
    const f = map[path];
    if (!f || f.type !== 'file' || f.encoding === 'base64') continue;
    const lines = String(f.content || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const start = Math.max(0, i - 4);
      const end = Math.min(lines.length, i + 8);
      hits.push({
        id: path + '#' + (start + 1) + '-' + end,
        path,
        startLine: start + 1,
        endLine: end,
        symbols: [],
        score: 1 / (1 + hits.length),
        preview: lines.slice(start, end).join('\n').slice(0, 400),
        source: 'rg',
      });
      if (hits.length >= topK * 3) break;
    }
    if (hits.length >= topK * 3) break;
  }
  return hits.slice(0, topK);
}

/**
 * Priompt-style priority packing with binary-search budget fit.
 */
function packContext(opts) {
  const o = opts || {};
  const files = o.files;
  const index = o.index;
  const query = o.query;
  const activeFile = o.activeFile;
  const openFiles = o.openFiles;
  const selection = o.selection;
  const cursor = o.cursor;
  const diagnostics = Array.isArray(o.diagnostics) ? o.diagnostics : [];
  const mode = String(o.mode || 'hybrid').toLowerCase();
  const budget = Math.min(Math.max(Number(o.maxChars) || 12000, 2000), 40000);

  const candidates = [];

  function addCandidate(priority, title, body, meta) {
    const text = String(body || '');
    if (!text.trim()) return;
    candidates.push({
      priority: Number(priority) || 0,
      title: String(title || ''),
      body: text,
      meta: meta || null,
    });
  }

  if (diagnostics.length) {
    addCandidate(
      PRIORITY.diagnostics,
      'Diagnostics / problems',
      diagnostics
        .slice(0, 20)
        .map(
          (d) =>
            '- [' +
            (d.severity || 'error') +
            '] ' +
            (d.path || d.file || '?') +
            (d.line != null ? ':' + d.line : '') +
            ' ' +
            (d.message || ''),
        )
        .join('\n'),
    );
  }
  if (selection && String(selection).trim()) {
    addCandidate(PRIORITY.selection, 'Current selection', String(selection).slice(0, 4000));
  }
  if (cursor && (cursor.line || cursor.column)) {
    addCandidate(
      PRIORITY.cursor,
      'Cursor',
      'line ' + (cursor.line || '?') + ', col ' + (cursor.column || '?'),
    );
  }
  if (activeFile) {
    addCandidate(
      PRIORITY.active,
      'Active file: ' + activeFile,
      readSlice(files, activeFile, 1, 220) || '(empty or missing)',
    );
  }
  if (Array.isArray(openFiles) && openFiles.length) {
    addCandidate(PRIORITY.openTabs, 'Open tabs', openFiles.slice(0, 12).join('\n'));
  }

  const q = query || activeFile || '';
  let hits = [];
  if (mode === 'bm25') {
    hits = searchIndex(index, q, { topK: 10 });
  } else if (mode === 'dense') {
    hits = denseSearch(index, q, { topK: 10 });
  } else if (mode === 'lexical' || mode === 'rg') {
    hits = lexicalScan(files, q, { topK: 10 });
  } else {
    // hybrid (default): BM25 + dense + lexical RRF
    const lexical = lexicalScan(files, q, { topK: 10 });
    hits = hybridSearch(index, q, { topK: 10, lexicalHits: lexical });
  }

  const seen = new Set(activeFile ? [activeFile + ':1'] : []);
  hits.forEach((h, i) => {
    const key = h.path + ':' + h.startLine;
    if (seen.has(key)) return;
    seen.add(key);
    const body = readSlice(files, h.path, h.startLine, h.endLine) || h.preview || '';
    const basePri =
      h.source === 'dense'
        ? PRIORITY.dense
        : h.source === 'rg'
          ? PRIORITY.rg
          : PRIORITY.bm25;
    const pri = basePri - i * 0.1;
    addCandidate(
      pri,
      'Retrieved ' +
        h.path +
        ':' +
        h.startLine +
        '-' +
        h.endLine +
        ' (' +
        (h.source || 'hit') +
        ' ' +
        h.score +
        ')',
      body,
      h,
    );
  });

  // Sort by priority desc, then binary-search how many fit
  candidates.sort((a, b) => b.priority - a.priority);

  function render(list) {
    const parts = [];
    let used = 0;
    for (const c of list) {
      const block = '### ' + c.title + '\n' + c.body + '\n';
      if (used + block.length > budget) {
        const room = Math.max(0, budget - used - c.title.length - 20);
        if (room < 80) break;
        parts.push('### ' + c.title + '\n' + c.body.slice(0, room) + '\n…\n');
        used = budget;
        break;
      }
      parts.push(block);
      used += block.length;
    }
    return { text: parts.join('\n'), chars: used };
  }

  // Binary search: drop lowest-priority items until under budget
  let lo = 1;
  let hi = candidates.length;
  let best = render(candidates.slice(0, Math.min(4, candidates.length)));
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const trial = render(candidates.slice(0, mid));
    if (trial.chars <= budget) {
      best = trial;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return {
    text: best.text,
    hits,
    chars: best.chars,
    mode,
    priorities: candidates.slice(0, 12).map((c) => ({
      title: c.title,
      priority: c.priority,
    })),
    indexMeta: index
      ? {
          revision: index.revision,
          chunkCount: index.chunkCount,
          fileCount: index.fileCount,
          builtAt: index.builtAt,
          merkleRoot: index.merkleRoot || null,
          engine: index.engine || 'chatre-context-v3',
          embed: index.embed || null,
        }
      : null,
  };
}

const COMPLETE_SYSTEM = `You are Chatre inline completion. Continue the code at the cursor.
Rules:
- Output ONLY the completion text to insert — no markdown fences, no explanations.
- Match indent and style of the prefix.
- Keep it short (1–12 lines) unless the prefix clearly needs more.`;

const EDIT_SYSTEM = `You are Chatre code editor. Apply the user's edit request using the provided workspace context.
Rules:
- Prefer a unified diff (--- a/path +++ b/path @@) when changing existing files.
- If creating a new file, output a fenced block with path hint: \`\`\`path=relative/file.ext
- No chit-chat. No inventing files that are not needed.`;

function buildCompleteMessages({ prefix, suffix, language, contextPack }) {
  const lang = language ? 'Language: ' + language + '\n' : '';
  const ctx = contextPack ? 'Context:\n' + contextPack + '\n\n' : '';
  return [
    { role: 'system', content: COMPLETE_SYSTEM },
    {
      role: 'user',
      content:
        ctx +
        lang +
        'Prefix:\n' +
        String(prefix || '').slice(-6000) +
        '\n\nSuffix:\n' +
        String(suffix || '').slice(0, 2000) +
        '\n\nComplete from the end of Prefix.',
    },
  ];
}

function buildEditMessages({ instruction, contextPack, activeFile }) {
  return [
    { role: 'system', content: EDIT_SYSTEM },
    {
      role: 'user',
      content:
        (activeFile ? 'Focus file: ' + activeFile + '\n\n' : '') +
        (contextPack ? '# Workspace context\n' + contextPack + '\n\n' : '') +
        '# Edit request\n' +
        String(instruction || ''),
    },
  ];
}

module.exports = {
  CODE_EXT,
  PRIORITY,
  tokenize,
  extractSymbols,
  contentHash,
  merkleRoot,
  chunkFile: chunkFileFixed,
  buildIndex,
  searchIndex,
  denseSearch,
  hybridSearch,
  lexicalScan,
  packContext,
  buildCompleteMessages,
  buildEditMessages,
  COMPLETE_SYSTEM,
  EDIT_SYSTEM,
};
