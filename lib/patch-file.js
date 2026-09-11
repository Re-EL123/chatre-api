'use strict';

/**
 * Apply search/replace or unified-diff style patches to file content.
 */

function applySearchReplace(content, oldStr, newStr, replaceAll) {
  const src = String(content ?? '');
  const oldS = String(oldStr ?? '');
  const newS = String(newStr ?? '');
  if (!oldS) return { ok: false, error: 'old_string required' };
  if (!src.includes(oldS)) {
    return { ok: false, error: 'old_string not found in file' };
  }
  let next;
  let count = 0;
  if (replaceAll) {
    next = src.split(oldS).join(newS);
    count = src.split(oldS).length - 1;
  } else {
    const idx = src.indexOf(oldS);
    next = src.slice(0, idx) + newS + src.slice(idx + oldS.length);
    count = 1;
  }
  return { ok: true, content: next, replacements: count };
}

/**
 * Minimal unified diff apply for single-file hunks (@@ lines).
 * Best-effort — prefers old_string/new_string for reliability.
 */
function applyUnifiedDiff(content, patchText) {
  const src = String(content ?? '');
  const lines = String(patchText || '').split(/\r?\n/);
  const removals = [];
  const additions = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) removals.push(line.slice(1));
    else if (line.startsWith('+')) additions.push(line.slice(1));
    else if (line.startsWith(' ')) {
      /* context ignored for naive apply */
    }
  }
  if (!removals.length && !additions.length) {
    return { ok: false, error: 'No hunks found in patch' };
  }
  const oldBlock = removals.join('\n');
  const newBlock = additions.join('\n');
  if (oldBlock && !src.includes(oldBlock)) {
    return {
      ok: false,
      error: 'Patch context not found; use old_string/new_string instead',
    };
  }
  if (!oldBlock) {
    return { ok: true, content: src + (src.endsWith('\n') ? '' : '\n') + newBlock };
  }
  return applySearchReplace(src, oldBlock, newBlock, false);
}

function patchFileContent(content, params) {
  const p = params || {};
  if (p.old_string != null || p.oldString != null) {
    return applySearchReplace(
      content,
      p.old_string != null ? p.old_string : p.oldString,
      p.new_string != null ? p.new_string : p.newString != null ? p.newString : '',
      !!(p.replace_all || p.replaceAll),
    );
  }
  if (p.patch || p.diff) {
    return applyUnifiedDiff(content, p.patch || p.diff);
  }
  return {
    ok: false,
    error: 'Provide old_string+new_string or patch (unified diff)',
  };
}

module.exports = {
  patchFileContent,
  applySearchReplace,
  applyUnifiedDiff,
};
