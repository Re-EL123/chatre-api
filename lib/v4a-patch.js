'use strict';

/**
 * V4A-style multi-file patches (Hermes/Codex-inspired).
 * Optional *** Begin Patch / *** End Patch framing.
 * Ops: Update / Add / Delete / Move File.
 */

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) >= 0) {
    n += 1;
    i += needle.length || 1;
  }
  return n;
}

function splitHunkLines(hunkLines) {
  const search = [];
  const replace = [];
  for (const raw of hunkLines || []) {
    if (raw == null) continue;
    let line = String(raw).replace(/\r$/, '');
    if (line === '\\ No newline at end of file' || line === '\\ No newline at end of file.') {
      continue;
    }
    let prefix = ' ';
    let content = line;
    if (line.length && (line[0] === ' ' || line[0] === '-' || line[0] === '+')) {
      prefix = line[0];
      content = line.slice(1);
    }
    if (prefix !== '+') search.push(content);
    if (prefix !== '-') replace.push(content);
  }
  return { search: search.join('\n'), replace: replace.join('\n') };
}

function parseHunkHeader(line) {
  const m = String(line || '').match(/^@@\s*(.*?)\s*@@/);
  return m ? String(m[1] || '').trim() : '';
}

function isHunkBodyStart(line) {
  if (!line || !line.length) return false;
  const c = line[0];
  return c === ' ' || c === '-' || c === '+' || c === '\\';
}

function parseV4aPatch(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  let body = raw;
  if (/\*\*\*\s*Begin Patch/i.test(raw)) {
    body = raw
      .replace(/^[\s\S]*?\*\*\*\s*Begin Patch\s*/i, '')
      .replace(/\*\*\*\s*End Patch[\s\S]*$/i, '');
  } else if (/\*\*\*\s*End Patch/i.test(raw)) {
    body = raw.replace(/\*\*\*\s*End Patch[\s\S]*$/i, '');
  }

  const ops = [];
  const lines = body.split('\n');
  let i = 0;

  function flushUpdate(path, hunks) {
    if (!path) return;
    if (!hunks.length) {
      ops.push({ type: 'update', path, hunks: [], error: 'UPDATE with no hunks' });
      return;
    }
    ops.push({ type: 'update', path, hunks });
  }

  while (i < lines.length) {
    const line = lines[i];
    if (/^\*\*\*\s*Add File:\s*/i.test(line)) {
      const path = line.replace(/^\*\*\*\s*Add File:\s*/i, '').trim();
      i += 1;
      const content = [];
      while (i < lines.length && !/^\*\*\*/.test(lines[i])) {
        const l = lines[i].replace(/\r$/, '');
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (l.startsWith(' ')) content.push(l.slice(1));
        // ignore '-' and bare lines for ADD
        i += 1;
      }
      if (!path) {
        ops.push({ type: 'add', path: '', ok: false, error: 'empty path' });
      } else {
        ops.push({ type: 'add', path, content: content.join('\n') });
      }
      continue;
    }
    if (/^\*\*\*\s*Delete File:\s*/i.test(line)) {
      ops.push({
        type: 'delete',
        path: line.replace(/^\*\*\*\s*Delete File:\s*/i, '').trim(),
      });
      i += 1;
      continue;
    }
    if (/^\*\*\*\s*Move File:\s*/i.test(line)) {
      const m = line.match(/^\*\*\*\s*Move File:\s*(.+?)\s*->\s*(.+)\s*$/i);
      if (m) ops.push({ type: 'move', from: m[1].trim(), to: m[2].trim() });
      else ops.push({ type: 'move', from: '', to: '', error: 'bad move header' });
      i += 1;
      continue;
    }
    if (/^\*\*\*\s*Update File:\s*/i.test(line)) {
      const path = line.replace(/^\*\*\*\s*Update File:\s*/i, '').trim();
      i += 1;
      const hunks = [];
      let current = null;
      while (i < lines.length && !/^\*\*\*/.test(lines[i])) {
        const l = lines[i].replace(/\r$/, '');
        if (/^@@/.test(l)) {
          if (current && current.lines.length) hunks.push(current);
          current = { contextHint: parseHunkHeader(l), lines: [] };
          i += 1;
          continue;
        }
        if (!current && isHunkBodyStart(l)) {
          current = { contextHint: '', lines: [] };
        }
        if (current) {
          current.lines.push(l);
          i += 1;
          continue;
        }
        i += 1;
      }
      if (current && current.lines.length) hunks.push(current);
      flushUpdate(path, hunks);
      continue;
    }
    i += 1;
  }

  if (!ops.length) return { ok: false, error: 'No V4A operations found' };
  return { ok: true, ops };
}

function isAlreadyApplied(content, search, replace) {
  if (!search) return false;
  if (content.includes(search)) return false;
  if (!replace) return false;
  return content.includes(replace);
}

function applyHunk(content, hunk) {
  const src = String(content ?? '');
  const hunkLines = Array.isArray(hunk) ? hunk : (hunk && hunk.lines) || [];
  const contextHint =
    !Array.isArray(hunk) && hunk && hunk.contextHint ? String(hunk.contextHint) : '';
  const { search, replace } = splitHunkLines(hunkLines);
  if (search === replace) {
    return { ok: true, content: src, noop: true };
  }

  // Addition-only
  if (!search) {
    const ins = replace + (replace.endsWith('\n') ? '' : '\n');
    if (contextHint) {
      const n = countOccurrences(src, contextHint);
      if (n !== 1) {
        return {
          ok: false,
          error:
            n === 0
              ? 'Addition hint not found'
              : 'Addition hint not unique (' + n + ')',
        };
      }
      const i = src.indexOf(contextHint);
      const eol = src.indexOf('\n', i);
      if (eol < 0) {
        return { ok: true, content: src + '\n' + ins };
      }
      return {
        ok: true,
        content: src.slice(0, eol + 1) + ins + src.slice(eol + 1),
      };
    }
    return {
      ok: true,
      content: src + (src.endsWith('\n') || !src ? '' : '\n') + ins,
    };
  }

  let idx = src.indexOf(search);
  if (idx < 0 && contextHint) {
    const hp = src.indexOf(contextHint);
    if (hp >= 0) {
      const w0 = Math.max(0, hp - 500);
      const w1 = Math.min(src.length, hp + 2000);
      const sub = src.slice(w0, w1);
      const j = sub.indexOf(search);
      if (j >= 0) {
        idx = w0 + j;
      }
    }
  }
  if (idx < 0) {
    if (isAlreadyApplied(src, search, replace)) {
      return { ok: true, content: src, alreadyApplied: true };
    }
    return { ok: false, error: 'Hunk context not found' };
  }
  if (src.indexOf(search, idx + 1) >= 0 && !contextHint) {
    return { ok: false, error: 'Hunk context not unique — need more context' };
  }
  return {
    ok: true,
    content: src.slice(0, idx) + replace + src.slice(idx + search.length),
  };
}

/**
 * Apply ops against files map: { [path]: { type, content } }.
 * Returns { ok, files, results }.
 */
function applyV4aOperations(files, ops) {
  const map = Object.assign({}, files || {});
  const results = [];
  let anyChange = false;

  for (const op of ops || []) {
    if (op.error) {
      results.push({
        op: op.type,
        path: op.path || op.from,
        ok: false,
        error: op.error,
      });
      continue;
    }
    if (op.type === 'add') {
      if (!op.path) {
        results.push({ op: 'add', path: '', ok: false, error: 'empty path' });
        continue;
      }
      if (map[op.path] && map[op.path].type === 'file') {
        results.push({
          op: 'add',
          path: op.path,
          ok: false,
          error: 'file already exists',
        });
        continue;
      }
      map[op.path] = {
        path: op.path,
        type: 'file',
        content: String(op.content || ''),
      };
      anyChange = true;
      results.push({ op: 'add', path: op.path, ok: true });
      continue;
    }
    if (op.type === 'delete') {
      if (!map[op.path]) {
        results.push({
          op: 'delete',
          path: op.path,
          ok: false,
          error: 'file missing',
        });
        continue;
      }
      delete map[op.path];
      anyChange = true;
      results.push({ op: 'delete', path: op.path, ok: true });
      continue;
    }
    if (op.type === 'move') {
      const src = map[op.from];
      if (!src || src.type !== 'file') {
        results.push({
          op: 'move',
          path: op.from,
          ok: false,
          error: 'source missing',
        });
        continue;
      }
      if (map[op.to]) {
        results.push({
          op: 'move',
          from: op.from,
          to: op.to,
          ok: false,
          error: 'destination exists',
        });
        continue;
      }
      map[op.to] = Object.assign({}, src, { path: op.to });
      delete map[op.from];
      anyChange = true;
      results.push({ op: 'move', from: op.from, to: op.to, ok: true });
      continue;
    }
    if (op.type === 'update') {
      const f = map[op.path];
      if (!f || f.type !== 'file') {
        results.push({
          op: 'update',
          path: op.path,
          ok: false,
          error: 'file missing',
        });
        continue;
      }
      if (!op.hunks || !op.hunks.length) {
        results.push({
          op: 'update',
          path: op.path,
          ok: false,
          error: 'no hunks',
        });
        continue;
      }
      let content = String(f.content || '');
      let failed = null;
      let changed = false;
      for (const hunk of op.hunks) {
        const r = applyHunk(content, hunk);
        if (!r.ok) {
          failed = r.error || 'hunk failed';
          break;
        }
        if (!r.noop && !r.alreadyApplied && r.content !== content) changed = true;
        content = r.content;
      }
      if (failed) {
        results.push({ op: 'update', path: op.path, ok: false, error: failed });
      } else {
        map[op.path] = Object.assign({}, f, { content });
        if (changed) anyChange = true;
        results.push({ op: 'update', path: op.path, ok: true });
      }
    }
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  if (ok && !anyChange) {
    // Context-only / already-applied-only patches are ok no-ops
    return { ok: true, files: map, results, noop: true };
  }
  return { ok, files: map, results };
}

function applyV4aPatchText(files, patchText) {
  const parsed = parseV4aPatch(patchText);
  if (!parsed.ok) return parsed;
  return applyV4aOperations(files, parsed.ops);
}

module.exports = {
  parseV4aPatch,
  applyV4aOperations,
  applyV4aPatchText,
  applyHunk,
  splitHunkLines,
};
