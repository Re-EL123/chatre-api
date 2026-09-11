'use strict';

/**
 * Resolve workspace-relative paths against cwd into absolute virtual paths.
 */
function resolveWorkspacePath(input, cwd) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw || raw === 'undefined' || raw === 'null') {
    return { ok: false, error: 'path is required' };
  }
  // Common aliases
  if (raw === '~') raw = '/home/user';
  if (raw.startsWith('~/')) raw = '/home/user/' + raw.slice(2);
  if (raw === '.' || raw === './') {
    return { ok: true, path: normalizeAbs(cwd || '/home/user') };
  }

  let abs;
  if (raw.startsWith('/')) {
    abs = raw;
  } else {
    const base = normalizeAbs(cwd || '/home/user');
    abs = base === '/' ? '/' + raw : base + '/' + raw;
  }
  abs = normalizeAbs(abs);
  if (!abs.startsWith('/')) abs = '/' + abs;
  return { ok: true, path: abs };
}

function normalizeAbs(p) {
  const parts = String(p || '/')
    .split('/')
    .filter((s) => s && s !== '.');
  const stack = [];
  for (const part of parts) {
    if (part === '..') {
      if (stack.length) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return '/' + stack.join('/');
}

function ensureParentDirs(files, filePath) {
  const parts = String(filePath).split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    const parent = cur || '/';
    cur = cur + '/' + parts[i];
    if (!files[cur]) {
      files[cur] = { path: cur, type: 'dir', children: [] };
    } else if (files[cur].type !== 'dir') {
      files[cur].type = 'dir';
      files[cur].children = files[cur].children || [];
    }
    if (files[parent] && Array.isArray(files[parent].children)) {
      if (!files[parent].children.includes(parts[i])) {
        files[parent].children.push(parts[i]);
      }
    }
  }
  const parent = filePath.replace(/\/[^/]+$/, '') || '/';
  const name = filePath.split('/').pop();
  if (parent !== filePath && files[parent] && Array.isArray(files[parent].children)) {
    if (!files[parent].children.includes(name)) {
      files[parent].children.push(name);
    }
  }
}

function toolParamsLookValid(call) {
  if (!call || !call.tool) return false;
  const p = call.params || {};
  switch (call.tool) {
    case 'execute_command':
      return !!(p.cmd || p.command);
    case 'write_file':
    case 'append_file':
      return !!(p.path || p.file) && p.content != null;
    case 'read_file':
    case 'delete_file':
    case 'export_document':
      return !!(p.path || p.file);
    case 'create_document':
      return !!(p.title && p.content != null);
    case 'git_commit':
      return !!p.message;
    case 'use_skill':
      return !!p.name;
    case 'plan':
      return !!p.steps;
    case 'copy_file':
      return !!(p.src || p.source) && !!(p.dest || p.destination);
    case 'find_files':
    case 'search_code':
      return !!(p.pattern || p.query || p.needle);
    case 'run_javascript':
    case 'run_python':
      return !!(p.code || p.source);
    default:
      return true;
  }
}

module.exports = {
  resolveWorkspacePath,
  normalizeAbs,
  ensureParentDirs,
  toolParamsLookValid,
};
