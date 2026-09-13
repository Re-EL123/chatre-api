'use strict';

/**
 * Context & Retrieval layer (RAG) for Chatre.
 *
 * Stack mapping (no new top-level API routes — stays within ≤12):
 *  1. Client editor → gathers active file / tabs / selection (FE)
 *  2. This module → AST-lite symbols + lexical vectors + pack
 *  3. /api/workspace?action=index|context → gateway actions
 *  4. /api/chat mode=complete|edit + /api/agent → inference
 *
 * Embeddings: lightweight bag-of-tokens vectors (local, no extra DB).
 * Upgrade path: swap embed() for Workers AI / Vectorize behind the same API.
 */

const CODE_EXT =
  /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte|html|css|scss|md|json|yml|yaml|toml|sh|sql)$/i;

const SKIP_PATH =
  /(?:^|\/)(?:node_modules|\.git|\.next|dist|build|coverage|\.cache|vendor)(?:\/|$)/i;

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

function chunkFile(path, content, opts) {
  const lines = String(content || '').split('\n');
  const size = (opts && opts.lines) || 80;
  const overlap = (opts && opts.overlap) || 12;
  const chunks = [];
  if (!lines.length) return chunks;
  for (let start = 0; start < lines.length; start += Math.max(1, size - overlap)) {
    const end = Math.min(lines.length, start + size);
    const body = lines.slice(start, end).join('\n');
    if (!body.trim()) {
      if (end >= lines.length) break;
      continue;
    }
    const symbols = extractSymbols(body, path);
    const tokens = tokenize(body + ' ' + symbols.join(' ') + ' ' + path);
    const tf = Object.create(null);
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    chunks.push({
      id: path + '#' + (start + 1) + '-' + end,
      path,
      startLine: start + 1,
      endLine: end,
      symbols,
      tf,
      preview: body.slice(0, 400),
      len: body.length,
    });
    if (end >= lines.length) break;
  }
  return chunks;
}

function buildIndex(files, opts) {
  const map = files && typeof files === 'object' ? files : {};
  const chunks = [];
  const paths = Object.keys(map).sort();
  let fileCount = 0;
  for (const path of paths) {
    if (SKIP_PATH.test(path) || !CODE_EXT.test(path)) continue;
    const f = map[path];
    if (!f || f.type !== 'file') continue;
    if (f.encoding === 'base64') continue;
    const content = String(f.content || '');
    if (!content || content.length > 400000) continue;
    fileCount += 1;
    chunks.push(...chunkFile(path, content, opts));
    if (chunks.length > 800) break;
  }
  const df = Object.create(null);
  for (const c of chunks) {
    const seen = new Set(Object.keys(c.tf));
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }
  return {
    revision: (opts && opts.revision) || 0,
    builtAt: new Date().toISOString(),
    fileCount,
    chunkCount: chunks.length,
    df,
    chunks: chunks.map((c) => ({
      id: c.id,
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      symbols: c.symbols,
      tf: c.tf,
      preview: c.preview,
      len: c.len,
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
  // Boost symbol / path hits
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
  }));
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
 * Pack a RAG bundle for the model: active file + selection + retrieved hits.
 */
function packContext({
  files,
  index,
  query,
  activeFile,
  openFiles,
  selection,
  cursor,
  maxChars,
}) {
  const budget = Math.min(Math.max(Number(maxChars) || 12000, 2000), 40000);
  const parts = [];
  let used = 0;

  function push(title, body) {
    const text = String(body || '');
    if (!text.trim()) return;
    const block = '### ' + title + '\n' + text + '\n';
    if (used + block.length > budget) {
      const room = Math.max(0, budget - used - title.length - 20);
      if (room < 80) return;
      parts.push('### ' + title + '\n' + text.slice(0, room) + '\n…\n');
      used = budget;
      return;
    }
    parts.push(block);
    used += block.length;
  }

  if (activeFile) {
    push(
      'Active file: ' + activeFile,
      readSlice(files, activeFile, 1, 220) || '(empty or missing)',
    );
  }
  if (selection && String(selection).trim()) {
    push('Current selection', String(selection).slice(0, 4000));
  }
  if (cursor && (cursor.line || cursor.column)) {
    push(
      'Cursor',
      'line ' + (cursor.line || '?') + ', col ' + (cursor.column || '?'),
    );
  }
  if (Array.isArray(openFiles) && openFiles.length) {
    push('Open tabs', openFiles.slice(0, 12).join('\n'));
  }

  const hits = searchIndex(index, query || activeFile || '', { topK: 8 });
  const seen = new Set(activeFile ? [activeFile] : []);
  for (const h of hits) {
    if (seen.has(h.path + ':' + h.startLine)) continue;
    seen.add(h.path + ':' + h.startLine);
    const body =
      readSlice(files, h.path, h.startLine, h.endLine) || h.preview || '';
    push(
      'Retrieved ' +
        h.path +
        ':' +
        h.startLine +
        '-' +
        h.endLine +
        ' (score ' +
        h.score +
        ')',
      body,
    );
    if (used >= budget) break;
  }

  return {
    text: parts.join('\n'),
    hits,
    chars: used,
    indexMeta: index
      ? {
          revision: index.revision,
          chunkCount: index.chunkCount,
          fileCount: index.fileCount,
          builtAt: index.builtAt,
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
  tokenize,
  extractSymbols,
  chunkFile,
  buildIndex,
  searchIndex,
  packContext,
  buildCompleteMessages,
  buildEditMessages,
  COMPLETE_SYSTEM,
  EDIT_SYSTEM,
};
