'use strict';

/**
 * Spill oversized tool outputs to a durable workspace file (OpenCode truncate pattern).
 * Returns a short preview + path so the model can read_file / search_code the full dump.
 */

const { ensureParentDirs } = require('./paths');

const MAX_LINES = 2000;
const MAX_BYTES = 50000;
const PREVIEW_HEAD = 8000;
const PREVIEW_TAIL = 8000;
const TMP_DIR = '/home/user/tmp';

function countLines(s) {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') n += 1;
  }
  return n;
}

function shouldSpill(text) {
  const s = String(text == null ? '' : text);
  if (s.length > MAX_BYTES) return true;
  return countLines(s) > MAX_LINES;
}

function previewText(s) {
  if (s.length <= PREVIEW_HEAD + PREVIEW_TAIL + 80) return s;
  const omitted = s.length - PREVIEW_HEAD - PREVIEW_TAIL;
  return (
    s.slice(0, PREVIEW_HEAD) +
    '\n…[truncated ' +
    omitted +
    ' bytes; full output at spill_path]…\n' +
    s.slice(-PREVIEW_TAIL)
  );
}

function nextSpillPath(files, toolName) {
  const safe = String(toolName || 'tool')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40);
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  let path = TMP_DIR + '/tool_' + safe + '_' + stamp + '_' + rand + '.txt';
  let i = 0;
  while (files && files[path] && i < 20) {
    i += 1;
    path = TMP_DIR + '/tool_' + safe + '_' + stamp + '_' + rand + '_' + i + '.txt';
  }
  return path;
}

/**
 * If text is large, write full content under /home/user/tmp and return a preview.
 * @param {string} text
 * @param {object} ctx — { files, filesTouched?, workspaceId?, putFile? }
 * @param {{ tool?: string, field?: string }} opts
 */
async function spillIfNeeded(text, ctx, opts) {
  const s = String(text == null ? '' : text);
  if (!shouldSpill(s)) {
    return {
      text: s,
      truncated: false,
      omitted: 0,
      spill_path: null,
      lines: countLines(s),
      bytes: s.length,
    };
  }

  const files = (ctx && ctx.files) || {};
  const tool = (opts && opts.tool) || 'tool';
  const spillPath = nextSpillPath(files, tool);
  ensureParentDirs(files, spillPath);
  files[spillPath] = {
    path: spillPath,
    type: 'file',
    content: s,
  };
  if (ctx && Array.isArray(ctx.filesTouched)) {
    ctx.filesTouched.push(spillPath);
  }
  if (ctx && typeof ctx.putFile === 'function' && ctx.workspaceId) {
    try {
      await ctx.putFile(ctx.workspaceId, files[spillPath]);
    } catch {
      /* best-effort persist */
    }
  } else if (ctx && ctx._putFile && ctx.workspaceId) {
    try {
      await ctx._putFile(ctx.workspaceId, files[spillPath]);
    } catch {
      /* ignore */
    }
  }

  const preview = previewText(s);
  const hint =
    '\n\n[Full output saved to ' +
    spillPath +
    '. Use read_file or search_code on that path. Do not re-run with head/tail.]';

  return {
    text: preview + hint,
    truncated: true,
    omitted: Math.max(0, s.length - PREVIEW_HEAD - PREVIEW_TAIL),
    spill_path: spillPath,
    lines: countLines(s),
    bytes: s.length,
  };
}

/**
 * Sync spill for callers that cannot await (mutates ctx.files).
 */
function spillIfNeededSync(text, ctx, opts) {
  const s = String(text == null ? '' : text);
  if (!shouldSpill(s)) {
    return {
      text: s,
      truncated: false,
      omitted: 0,
      spill_path: null,
      lines: countLines(s),
      bytes: s.length,
    };
  }
  const files = (ctx && ctx.files) || {};
  const tool = (opts && opts.tool) || 'tool';
  const spillPath = nextSpillPath(files, tool);
  ensureParentDirs(files, spillPath);
  files[spillPath] = {
    path: spillPath,
    type: 'file',
    content: s,
  };
  if (ctx && Array.isArray(ctx.filesTouched)) {
    ctx.filesTouched.push(spillPath);
  }
  const preview = previewText(s);
  const hint =
    '\n\n[Full output saved to ' +
    spillPath +
    '. Use read_file or search_code on that path. Do not re-run with head/tail.]';
  return {
    text: preview + hint,
    truncated: true,
    omitted: Math.max(0, s.length - PREVIEW_HEAD - PREVIEW_TAIL),
    spill_path: spillPath,
    lines: countLines(s),
    bytes: s.length,
  };
}

/**
 * Soft-shrink for LLM context, preferring spill metadata already on the result.
 */
function shrinkWithSpill(result, budget) {
  const limit = budget || 900;
  if (!result || typeof result !== 'object') return result;
  const clone = Object.assign({}, result);
  ['output', 'content', 'text', 'guide', 'stdout', 'stderr'].forEach((k) => {
    if (typeof clone[k] !== 'string') return;
    if (clone.spill_path && clone[k].length > limit) {
      clone[k] =
        clone[k].slice(0, Math.min(limit, 600)) +
        '\n…[see spill_path ' +
        clone.spill_path +
        ']';
      return;
    }
    if (clone[k].length > limit) {
      clone[k] =
        clone[k].slice(0, limit) +
        '\n…[truncated ' +
        clone[k].length +
        ' chars]';
    }
  });
  return clone;
}

module.exports = {
  MAX_LINES,
  MAX_BYTES,
  TMP_DIR,
  shouldSpill,
  spillIfNeeded,
  spillIfNeededSync,
  shrinkWithSpill,
  countLines,
};
