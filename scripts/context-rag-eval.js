'use strict';

/**
 * Smoke eval: dense hybrid retrieval + AST outline + import graph.
 * Run: node scripts/context-rag-eval.js
 */

const ContextRag = require('../lib/context-rag');
const AstParser = require('../lib/ast-parser');
const ImportGraph = require('../lib/import-graph');
const Embed = require('../lib/embed');
const FileOutline = require('../lib/file-outline');
const McpClient = require('../lib/mcp-client');

const files = {
  '/home/user/projects/demo/src/auth/jwt.ts': {
    type: 'file',
    content: `
import { sign, verify } from './crypto';
import { User } from '../models/user';

export function createToken(user: User) {
  return sign({ sub: user.id });
}

export class AuthService {
  login(email: string, password: string) {
    return createToken({ id: '1', email } as User);
  }
}
`,
  },
  '/home/user/projects/demo/src/auth/crypto.ts': {
    type: 'file',
    content: `
export function sign(payload: object) {
  return JSON.stringify(payload);
}
export function verify(token: string) {
  return JSON.parse(token);
}
`,
  },
  '/home/user/projects/demo/src/models/user.ts': {
    type: 'file',
    content: `
export type User = { id: string; email: string };
export function isAdmin(user: User) {
  return user.email.endsWith('@admin.test');
}
`,
  },
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function main() {
  const v = Embed.embedText('user authentication jwt token');
  assert(v && v.length === Embed.DEFAULT_DIM, 'embed dim');

  const index = ContextRag.buildIndex(files, { revision: 1 });
  assert(index.engine === 'chatre-context-v3', 'engine v3');
  assert(index.chunks.some((c) => c.vec && c.vec.length), 'chunks have vectors');

  const dense = ContextRag.denseSearch(index, 'user authentication', { topK: 5 });
  assert(dense.length > 0, 'dense hits');
  assert(
    dense.some((h) => /auth|jwt|user/i.test(h.path)),
    'dense finds auth-related path',
  );

  const hybrid = ContextRag.hybridSearch(index, 'ERR_CONN_TIMEOUT_302 createToken', {
    topK: 8,
    lexicalHits: ContextRag.lexicalScan(files, 'createToken', { topK: 5 }),
  });
  assert(hybrid.length > 0, 'hybrid hits');
  assert(
    hybrid.some((h) => String(h.preview || '').includes('createToken') || h.path.includes('jwt')),
    'hybrid finds createToken',
  );

  const outline = FileOutline.outlineFile(
    '/home/user/projects/demo/src/auth/jwt.ts',
    files['/home/user/projects/demo/src/auth/jwt.ts'].content,
  );
  assert(outline.count >= 2, 'outline has symbols');
  assert(
    outline.outline.some((o) => o.name === 'AuthService' || o.name === 'createToken'),
    'outline names',
  );

  const parsed = AstParser.parseFileSync(
    '/home/user/projects/demo/src/auth/jwt.ts',
    files['/home/user/projects/demo/src/auth/jwt.ts'].content,
  );
  assert(parsed.imports.length >= 2, 'ast imports');

  const graph = ImportGraph.buildImportGraph(files);
  assert(graph.edgeCount >= 2, 'import edges');
  const resolved = ImportGraph.resolveSymbol(graph, 'AuthService');
  assert(resolved.ok && resolved.count >= 1, 'resolve AuthService');
  const neigh = ImportGraph.neighbors(
    graph,
    '/home/user/projects/demo/src/auth/jwt.ts',
    'imports',
    1,
  );
  assert(neigh.edges.length >= 1, 'neighbors');

  const mcp = McpClient.searchRegistry('github slack');
  assert(mcp.length >= 1, 'mcp registry search');

  const pack = ContextRag.packContext({
    files,
    index,
    query: 'authentication token login',
    mode: 'hybrid',
    maxChars: 4000,
  });
  assert(pack.text && pack.hits && pack.hits.length, 'pack context');

  console.log(
    JSON.stringify(
      {
        ok: true,
        engine: index.engine,
        chunks: index.chunkCount,
        denseTop: dense[0] && dense[0].path,
        hybridTop: hybrid[0] && hybrid[0].path,
        outlineEngine: outline.engine,
        importEdges: graph.edgeCount,
        mcpHits: mcp.map((m) => m.uuid),
        packChars: pack.chars,
      },
      null,
      2,
    ),
  );
}

main();
