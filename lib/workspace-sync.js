'use strict';

/**
 * Workspace solidity helpers — hashing, merge, prune, binary policy, tree delete.
 */

const crypto = require('crypto');

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_SSE_CONTENT = 100 * 1024;

function contentHash(entry) {
  if (!entry) return '';
  const type = entry.type || (entry.content != null ? 'file' : 'dir');
  if (type === 'dir') {
    const kids = Array.isArray(entry.children) ? entry.children.slice().sort().join(',') : '';
    return crypto
      .createHash('sha1')
      .update('dir|' + (entry.path || '') + '|' + kids + (entry.stub ? '|stub' : ''))
      .digest('hex');
  }
  const enc = entry.encoding === 'base64' ? 'base64' : 'utf8';
  const body = entry.content == null ? '' : String(entry.content);
  return crypto
    .createHash('sha1')
    .update(
      'file|' +
        (entry.path || '') +
        '|' +
        enc +
        '|' +
        (entry.truncated ? '1' : '0') +
        '|' +
        body,
    )
    .digest('hex');
}

function fileChanged(a, b) {
  if (!a && !b) return false;
  if (!a || !b) return true;
  if ((a.type || 'file') !== (b.type || 'file')) return true;
  return contentHash(a) !== contentHash(b);
}

function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  const sample = buf.length > 8000 ? buf.slice(0, 8000) : buf;
  let weird = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === 0) return true;
    if (c < 7 || (c > 13 && c < 32)) weird += 1;
  }
  return weird / sample.length > 0.3;
}

function isProtectedPath(p) {
  const s = String(p || '');
  return /\/node_modules(\/|$)/.test(s) || /\/\.git(\/|$)/.test(s);
}

function shouldPrunePath(p) {
  if (!p || p === '/') return false;
  if (isProtectedPath(p)) return false;
  return true;
}

/**
 * Read a file from disk into a workspace entry (utf8 or base64, with truncate marker).
 */
function readDiskFileEntry(absPath, virtPath, st) {
  const size = st && typeof st.size === 'number' ? st.size : 0;
  let buf;
  try {
    buf = require('fs').readFileSync(absPath);
  } catch {
    return {
      path: virtPath,
      type: 'file',
      content: '',
      encoding: 'utf8',
      size: 0,
      error: 'unreadable',
    };
  }
  const binary = looksBinary(buf);
  if (binary) {
    const slice = size > MAX_TEXT_BYTES ? buf.slice(0, MAX_TEXT_BYTES) : buf;
    return {
      path: virtPath,
      type: 'file',
      content: slice.toString('base64'),
      encoding: 'base64',
      size,
      truncated: size > MAX_TEXT_BYTES,
      binary: true,
    };
  }
  const text = buf.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES || size > MAX_TEXT_BYTES) {
    const sliced = buf.slice(0, MAX_TEXT_BYTES).toString('utf8');
    return {
      path: virtPath,
      type: 'file',
      content: sliced,
      encoding: 'utf8',
      size,
      truncated: true,
    };
  }
  return {
    path: virtPath,
    type: 'file',
    content: text,
    encoding: 'utf8',
    size,
    truncated: false,
  };
}

/**
 * Apply a collected entry onto a previous entry without empty-clobber.
 */
function applyCollectedEntry(prev, incoming) {
  if (!incoming) return prev || null;
  if (incoming.stub) {
    return prev && prev.type === 'dir' ? prev : incoming;
  }
  if (incoming.type === 'dir') {
    return {
      path: incoming.path,
      type: 'dir',
      children: Array.isArray(incoming.children) ? incoming.children.slice() : [],
      stub: !!incoming.stub,
    };
  }
  const nextContent = incoming.content == null ? '' : String(incoming.content);
  const prevContent =
    prev && prev.type === 'file' && prev.content != null ? String(prev.content) : '';

  // Never replace non-empty with empty (failed read / race)
  if (
    prev &&
    prev.type === 'file' &&
    prevContent.length > 0 &&
    nextContent.length === 0 &&
    !incoming.forceEmpty
  ) {
    return prev;
  }

  return {
    path: incoming.path || (prev && prev.path),
    type: 'file',
    content: nextContent,
    encoding: incoming.encoding === 'base64' ? 'base64' : prev && prev.encoding === 'base64' && incoming.encoding !== 'utf8' ? 'base64' : (incoming.encoding || 'utf8'),
    size: incoming.size != null ? incoming.size : prev && prev.size,
    truncated: !!incoming.truncated,
    binary: !!incoming.binary,
    previousContent: prevContent && prevContent !== nextContent ? prevContent : prev && prev.previousContent,
  };
}

/**
 * Merge shell/sandbox collect output into the prior workspace map.
 * Collected tree wins for non-protected paths; empty clobber blocked; stubs preserved.
 */
function mergeCollectedFiles(prevFiles, collected) {
  const prev = prevFiles || {};
  const col = collected || {};
  const next = {};

  Object.keys(col).forEach((p) => {
    next[p] = applyCollectedEntry(prev[p], col[p]);
  });

  // Keep protected paths from prev if collect only stubbed them
  Object.keys(prev).forEach((p) => {
    if (next[p]) return;
    if (isProtectedPath(p)) next[p] = prev[p];
  });

  // Ensure skeleton dirs exist
  ['/', '/home', '/home/user', '/home/user/documents', '/home/user/projects', '/tmp', '/etc'].forEach(
    (p) => {
      if (!next[p] && prev[p]) next[p] = prev[p];
    },
  );

  return next;
}

/**
 * Remove a path (and descendants) from an in-memory files map; fix parent children.
 */
function removePathFromTree(files, targetPath) {
  const path = String(targetPath || '');
  if (!path || path === '/') return { files, deleted: [] };
  const deleted = [];
  const prefix = path.endsWith('/') ? path : path + '/';
  Object.keys(files || {}).forEach((p) => {
    if (p === path || p.indexOf(prefix) === 0) {
      delete files[p];
      deleted.push(p);
    }
  });
  const parent = path.replace(/\/[^/]+$/, '') || '/';
  const base = path.split('/').pop();
  if (files[parent] && Array.isArray(files[parent].children)) {
    files[parent].children = files[parent].children.filter((c) => c !== base);
  }
  return { files, deleted };
}

/**
 * Guard: refuse emptying an existing non-empty file unless allowed.
 */
function emptyWriteBlocked(existing, content, opts) {
  const o = opts || {};
  if (o.allowEmpty || o.overwrite_empty || o.overwriteEmpty) return null;
  if (!existing || existing.type !== 'file') return null;
  const prev = existing.content == null ? '' : String(existing.content);
  const next = content == null ? '' : String(content);
  if (prev.length > 0 && next.length === 0) {
    return {
      blocked: true,
      error:
        'Refusing to overwrite non-empty file with empty content. Pass overwrite_empty:true to force.',
    };
  }
  return null;
}

function ssePayloadForFile(entry, revision) {
  if (!entry || !entry.path) return null;
  const base = {
    path: entry.path,
    type: entry.type || 'file',
    encoding: entry.encoding || 'utf8',
    truncated: !!entry.truncated,
    binary: !!entry.binary,
    revision: revision != null ? revision : undefined,
    hash: contentHash(entry),
  };
  if (entry.type === 'dir') {
    base.children = entry.children || [];
    return base;
  }
  const content = entry.content == null ? '' : String(entry.content);
  if (Buffer.byteLength(content, 'utf8') <= MAX_SSE_CONTENT) {
    base.content = content;
  } else {
    base.contentOmitted = true;
    base.size = entry.size != null ? entry.size : content.length;
  }
  return base;
}

module.exports = {
  MAX_TEXT_BYTES,
  MAX_SSE_CONTENT,
  contentHash,
  fileChanged,
  looksBinary,
  isProtectedPath,
  shouldPrunePath,
  readDiskFileEntry,
  applyCollectedEntry,
  mergeCollectedFiles,
  removePathFromTree,
  emptyWriteBlocked,
  ssePayloadForFile,
};
