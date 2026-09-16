'use strict';

/**
 * Structural AST + import extraction for coding-agent context.
 *
 * Primary engine: brace-aware recursive parser producing tree-sitter-compatible
 * node types (function_declaration, class_declaration, import_statement, …).
 *
 * Optional: set CHATRE_TREE_SITTER=1 and install web-tree-sitter + grammar WASM
 * under lib/wasm/ to prefer a real tree-sitter parse (falls back automatically).
 */

const path = require('path');

const LANG_BY_EXT = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
};

function detectLang(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return LANG_BY_EXT[ext] || 'text';
}

function lineOffsets(src) {
  const offs = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') offs.push(i + 1);
  }
  return offs;
}

function offsetToLine(offs, offset) {
  let lo = 0;
  let hi = offs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offs[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

function makeNode(type, name, startLine, endLine, extra) {
  return Object.assign(
    {
      type,
      name: name || null,
      startLine,
      endLine,
      children: [],
    },
    extra || {},
  );
}

/**
 * Find matching closing brace from an opening `{` index (string/comment aware for JS-like).
 */
function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (ch === '\n') inLine = false;
      i += 1;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function matchPythonBlock(lines, startLineIdx) {
  const base = lines[startLineIdx] || '';
  const indentMatch = base.match(/^(\s*)/);
  const baseIndent = indentMatch ? indentMatch[1].length : 0;
  let end = startLineIdx;
  for (let i = startLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      end = i;
      continue;
    }
    const m = line.match(/^(\s*)/);
    const ind = m ? m[1].length : 0;
    if (ind <= baseIndent) break;
    end = i;
  }
  return end;
}

function parseJsLike(filePath, content) {
  const src = String(content || '');
  const offs = lineOffsets(src);
  const root = makeNode('program', path.basename(String(filePath || '')), 1, offs.length);
  const imports = [];
  const exports = [];
  const outline = [];

  const importRe =
    /^\s*(?:import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|const\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)|export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"])/gm;

  let im;
  while ((im = importRe.exec(src))) {
    const spec = im[1] || im[2] || im[3] || im[4];
    if (!spec) continue;
    const line = offsetToLine(offs, im.index);
    const kind = /export/.test(im[0]) ? 'export' : /require/.test(im[0]) ? 'require' : 'import';
    imports.push({
      kind,
      source: spec,
      line,
      preview: String(im[0]).trim().slice(0, 120),
    });
    root.children.push(
      makeNode('import_statement', spec, line, line, { source: spec, kind }),
    );
  }

  const declRes = [
    {
      type: 'function_declaration',
      kind: 'function',
      re: /(?:^|\n)((?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*)([A-Za-z_$][\w$]*)\s*\(/g,
    },
    {
      type: 'class_declaration',
      kind: 'class',
      re: /(?:^|\n)((?:export\s+(?:default\s+)?)?class\s+)([A-Za-z_$][\w$]*)/g,
    },
    {
      type: 'interface_declaration',
      kind: 'type',
      re: /(?:^|\n)((?:export\s+)?interface\s+)([A-Za-z_$][\w$]*)/g,
    },
    {
      type: 'type_alias_declaration',
      kind: 'type',
      re: /(?:^|\n)((?:export\s+)?type\s+)([A-Za-z_$][\w$]*)\s*=/g,
    },
    {
      type: 'lexical_declaration',
      kind: 'const',
      re: /(?:^|\n)((?:export\s+)?(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g,
    },
  ];

  for (const rule of declRes) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src))) {
      const name = m[2];
      const startOffset = m.index + (m[0].startsWith('\n') ? 1 : 0);
      const startLine = offsetToLine(offs, startOffset);
      let endLine = startLine;
      const braceAt = src.indexOf('{', startOffset + m[0].length - (m[0].startsWith('\n') ? 1 : 0));
      if (braceAt > startOffset && braceAt < startOffset + 400) {
        const close = matchBrace(src, braceAt);
        if (close > braceAt) endLine = offsetToLine(offs, close);
      }
      const node = makeNode(rule.type, name, startLine, endLine);
      root.children.push(node);
      outline.push({
        kind: rule.kind,
        name,
        line: startLine,
        endLine,
        preview: src.slice(startOffset, startOffset + 100).split('\n')[0].trim().slice(0, 120),
      });
      if (/^\s*export\b/.test(m[1] || '')) {
        exports.push({ name, line: startLine, kind: rule.kind });
      }
    }
  }

  root.endLine = Math.max(root.endLine, ...outline.map((o) => o.endLine || o.line), 1);
  return { root, imports, exports, outline, engine: 'chatre-ast' };
}

function parsePython(filePath, content) {
  const src = String(content || '');
  const lines = src.split('\n');
  const root = makeNode('module', path.basename(String(filePath || '')), 1, lines.length);
  const imports = [];
  const exports = [];
  const outline = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(/^\s*(?:from\s+(\S+)\s+import\s+.+|import\s+(\S+))/);
    if (m) {
      const source = m[1] || m[2];
      imports.push({
        kind: m[1] ? 'from' : 'import',
        source,
        line: i + 1,
        preview: line.trim().slice(0, 120),
      });
      root.children.push(
        makeNode('import_statement', source, i + 1, i + 1, { source, kind: m[1] ? 'from' : 'import' }),
      );
      continue;
    }
    m = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (m) {
      const end = matchPythonBlock(lines, i);
      const node = makeNode('function_definition', m[1], i + 1, end + 1);
      root.children.push(node);
      outline.push({
        kind: 'def',
        name: m[1],
        line: i + 1,
        endLine: end + 1,
        preview: line.trim().slice(0, 120),
      });
      exports.push({ name: m[1], line: i + 1, kind: 'def' });
      continue;
    }
    m = line.match(/^\s*class\s+([A-Za-z_][\w]*)/);
    if (m) {
      const end = matchPythonBlock(lines, i);
      const node = makeNode('class_definition', m[1], i + 1, end + 1);
      root.children.push(node);
      outline.push({
        kind: 'class',
        name: m[1],
        line: i + 1,
        endLine: end + 1,
        preview: line.trim().slice(0, 120),
      });
      exports.push({ name: m[1], line: i + 1, kind: 'class' });
    }
  }

  return { root, imports, exports, outline, engine: 'chatre-ast' };
}

function parseGeneric(filePath, content) {
  const src = String(content || '');
  const lines = src.split('\n');
  const root = makeNode('program', path.basename(String(filePath || '')), 1, lines.length);
  const outline = [];
  const re =
    /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|interface|type|impl|struct|enum)\s+([A-Za-z_][\w]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    outline.push({
      kind: 'symbol',
      name: m[1],
      line: i + 1,
      endLine: i + 1,
      preview: lines[i].trim().slice(0, 120),
    });
    root.children.push(makeNode('declaration', m[1], i + 1, i + 1));
  }
  return { root, imports: [], exports: [], outline, engine: 'chatre-ast' };
}

async function tryTreeSitter(filePath, content, lang) {
  if (String(process.env.CHATRE_TREE_SITTER || '') !== '1') return null;
  let Parser;
  try {
    Parser = require('web-tree-sitter');
  } catch {
    return null;
  }
  try {
    if (typeof Parser.init === 'function') await Parser.init();
    const parser = new Parser();
    const wasmPath = path.join(__dirname, 'wasm', 'tree-sitter-' + lang + '.wasm');
    const fs = require('fs');
    if (!fs.existsSync(wasmPath)) return null;
    const Lang = await Parser.Language.load(wasmPath);
    parser.setLanguage(Lang);
    const tree = parser.parse(String(content || ''));
    return treeToAst(filePath, content, tree);
  } catch {
    return null;
  }
}

function treeToAst(filePath, content, tree) {
  const src = String(content || '');
  const lines = src.split('\n');
  const imports = [];
  const exports = [];
  const outline = [];

  function walk(node, parent) {
    const type = node.type;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    let name = null;
    const nameNode =
      node.childForFieldName &&
      (node.childForFieldName('name') || node.childForFieldName('property'));
    if (nameNode) name = nameNode.text;

    const astNode = makeNode(type, name, startLine, endLine);
    if (parent) parent.children.push(astNode);

    if (/import/.test(type)) {
      const text = src.slice(node.startIndex, node.endIndex);
      const m = text.match(/['"]([^'"]+)['"]/);
      if (m) {
        imports.push({
          kind: 'import',
          source: m[1],
          line: startLine,
          preview: text.trim().slice(0, 120),
        });
      }
    }
    if (
      /function_declaration|class_declaration|method_definition|function_definition|class_definition/.test(
        type,
      ) &&
      name
    ) {
      const kind = /class/.test(type) ? 'class' : /method/.test(type) ? 'method' : 'function';
      outline.push({
        kind,
        name,
        line: startLine,
        endLine,
        preview: (lines[startLine - 1] || '').trim().slice(0, 120),
      });
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), astNode);
    }
    return astNode;
  }

  const root = walk(tree.rootNode, null);
  root.name = path.basename(String(filePath || ''));
  return { root, imports, exports, outline, engine: 'tree-sitter' };
}

/**
 * Parse a file into AST + outline + imports/exports.
 */
async function parseFile(filePath, content) {
  const lang = detectLang(filePath);
  const ts = await tryTreeSitter(filePath, content, lang === 'typescript' ? 'typescript' : lang);
  if (ts) return Object.assign({ lang, path: filePath }, ts);

  let parsed;
  if (lang === 'python') parsed = parsePython(filePath, content);
  else if (lang === 'javascript' || lang === 'typescript') parsed = parseJsLike(filePath, content);
  else parsed = parseGeneric(filePath, content);

  return Object.assign({ lang, path: filePath }, parsed);
}

function parseFileSync(filePath, content) {
  const lang = detectLang(filePath);
  let parsed;
  if (lang === 'python') parsed = parsePython(filePath, content);
  else if (lang === 'javascript' || lang === 'typescript') parsed = parseJsLike(filePath, content);
  else parsed = parseGeneric(filePath, content);
  return Object.assign({ lang, path: filePath, engine: parsed.engine }, parsed);
}

/** Structural break lines for chunking (1-based). */
function structuralBreakLines(filePath, content) {
  const parsed = parseFileSync(filePath, content);
  const breaks = new Set([1]);
  (parsed.outline || []).forEach((o) => {
    if (o.line) breaks.add(o.line);
  });
  return [...breaks].sort((a, b) => a - b);
}

module.exports = {
  detectLang,
  parseFile,
  parseFileSync,
  structuralBreakLines,
  matchBrace,
};
