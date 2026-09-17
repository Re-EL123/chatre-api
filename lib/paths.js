'use strict';

/**
 * Resolve workspace-relative paths against cwd into absolute virtual paths.
 * Collapses /projects/<slug>/<slug>/ doubles (common model mistake when cwd
 * is already the project root).
 */

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

/**
 * /home/user/projects/foo/foo/bar → /home/user/projects/foo/bar
 * /home/user/projects/foo/home/user/projects/foo/bar → /home/user/projects/foo/bar
 * Also collapses repeated identical segments under projects/.
 */
function collapseProjectDoublePath(abs) {
  let p = normalizeAbs(abs);
  for (let i = 0; i < 8; i++) {
    let next = p.replace(
      /^(\/home\/user\/projects\/([^/]+))\/home\/user\/projects\/\2(?=\/|$)/,
      '$1',
    );
    next = next.replace(
      /^(\/home\/user\/projects\/)([^/]+)\/\2(?=\/|$)/,
      '$1$2',
    );
    // Also collapse .../home/user/home/user/...
    next = next.replace(/(\/home\/user)\/home\/user(?=\/|$)/g, '$1');
    if (next === p) break;
    p = next;
  }
  return p;
}

/**
 * If cwd is /home/user/projects/<slug> and relative starts with <slug>/,
 * strip the redundant prefix before joining.
 */
function stripRedundantProjectPrefix(raw, cwd) {
  const base = normalizeAbs(cwd || '/home/user');
  const m = base.match(/^\/home\/user\/projects\/([^/]+)$/);
  if (!m) return raw;
  const slug = m[1];
  const re = new RegExp(
    '^(?:\\.?\\/)?' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/',
  );
  return String(raw || '').replace(re, '');
}

/**
 * Models often omit the leading slash: home/user/projects/...
 * Treat those as absolute virtual paths, not cwd-relative.
 */
function coerceVirtualAbs(raw) {
  let s = String(raw || '').trim();
  if (!s) return s;
  // file:///home/user/...
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, '');
  }
  if (s.startsWith('/')) return s;
  if (/^(home\/user|tmp|etc)(\/|$)/i.test(s)) {
    return '/' + s.replace(/^\/+/, '');
  }
  // Absolute-looking project path without leading slash
  if (/^home\/user\/projects\//i.test(s) || /^projects\/[^/]+\//i.test(s)) {
    return '/' + s.replace(/^\/+/, '').replace(/^projects\//i, 'home/user/projects/');
  }
  return s;
}

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

  raw = coerceVirtualAbs(raw);

  let abs;
  if (raw.startsWith('/')) {
    abs = raw;
  } else {
    raw = stripRedundantProjectPrefix(raw, cwd);
    const base = normalizeAbs(cwd || '/home/user');
    abs = base === '/' ? '/' + raw : base + '/' + raw;
  }
  abs = collapseProjectDoublePath(normalizeAbs(abs));
  if (!abs.startsWith('/')) abs = '/' + abs;

  // Still nested after collapse → repair by collapsing repeated project roots
  if (/\/home\/user\/projects\/[^/]+\/home\/user\//.test(abs)) {
    const m = abs.match(
      /^(\/home\/user\/projects\/[^/]+)(?:\/home\/user\/projects\/[^/]+)+(.*)$/,
    );
    if (m) {
      return {
        ok: true,
        path: collapseProjectDoublePath(normalizeAbs(m[1] + (m[2] || ''))),
        repaired: true,
      };
    }
    return {
      ok: false,
      error:
        'Invalid nested workspace path: ' +
        abs +
        '. Use /home/user/projects/<slug>/… (absolute) or a path relative to the project cwd — not home/user/... under an existing project.',
      path: abs,
    };
  }

  return { ok: true, path: abs };
}

/**
 * OpenCode-style miss helper: suggest sibling / inventory paths.
 */
function suggestSimilarPaths(files, attemptedPath, limit) {
  const lim = limit || 6;
  const map = files || {};
  const attempted = String(attemptedPath || '');
  const base = attempted.split('/').pop() || '';
  const parent = attempted.replace(/\/[^/]+$/, '') || '/';
  const all = Object.keys(map)
    .filter((p) => map[p] && map[p].type === 'file')
    .sort();
  const scored = [];
  for (const p of all) {
    const name = p.split('/').pop() || '';
    let score = 0;
    if (p.startsWith(parent + '/') || p === parent) score += 3;
    if (base && name.toLowerCase() === base.toLowerCase()) score += 5;
    else if (base && name.toLowerCase().includes(base.toLowerCase())) score += 2;
    else if (base && base.toLowerCase().includes(name.toLowerCase())) score += 1;
    if (score > 0) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.p.localeCompare(b.p));
  const picks = scored.slice(0, lim).map((x) => x.p);
  if (!picks.length) {
    return all.slice(0, lim);
  }
  return picks;
}

function pathMissResult(tool, files, attemptedPath) {
  const suggestions = suggestSimilarPaths(files, attemptedPath, 8);
  let error = 'No such file: ' + attemptedPath;
  if (suggestions.length) {
    error +=
      '\n\nDid you mean one of these?\n' +
      suggestions.map((s) => '- ' + s).join('\n') +
      '\n\nUse only paths from workspace inventory / view_tree. Do not invent style.css, script.js, or css/js folders.';
  } else {
    error +=
      '\n\nWorkspace has no matching files. Call view_tree("/home/user") or use inventory paths — never invent paths.';
  }
  return {
    ok: false,
    tool,
    error,
    path: attemptedPath,
    suggestions,
    invent_path: true,
  };
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
  return validateToolCall(call).ok;
}

/**
 * Hard validation with a fix hint (OpenCode invalid-tool pattern).
 * Empty/malformed required params must fail loudly — never silent drop.
 */
function validateToolCall(call) {
  if (!call || !call.tool) {
    return {
      ok: false,
      error: 'Invalid tool call: missing tool name.',
      hint: 'Emit a tool object with "tool" (or function.name) and params.',
    };
  }
  if (call.parseFailed) {
    return {
      ok: false,
      error: 'Invalid tool call: could not parse arguments JSON for "' + call.tool + '".',
      hint: 'Pass a single JSON object for arguments (brace-balanced, no trailing commas).',
    };
  }
  const p = call.params || {};
  const tool = call.tool;
  const fail = (error, hint) => ({ ok: false, error, hint, tool });

  switch (tool) {
    case 'todo':
      if (!p.action) {
        return fail(
          'todo requires action',
          'Use action: set|add|done|list (plus items/id/content as needed).',
        );
      }
      break;
    case 'todo_write':
      if (!Array.isArray(p.todos) && !Array.isArray(p.items)) {
        return fail(
          'todo_write requires todos[]',
          'Pass todos: [{id, content, status}].',
        );
      }
      break;
    case 'execute_command':
      if (!(p.cmd || p.command)) {
        return fail(
          'execute_command requires cmd (or command)',
          'Example: {"tool":"execute_command","cmd":"npm test","cwd":"/home/user/projects/app"}',
        );
      }
      break;
    case 'write_file':
    case 'append_file':
      if (!(p.path || p.file)) {
        return fail(tool + ' requires path', 'Pass path under /home/user/…');
      }
      if (p.content == null) {
        return fail(tool + ' requires content', 'Pass full file content as a string.');
      }
      break;
    case 'read_file':
    case 'delete_file':
    case 'export_document':
      if (!(p.path || p.file)) {
        return fail(tool + ' requires path', 'Pass path under /home/user/…');
      }
      break;
    case 'verify_project':
    case 'preview_project':
      if (!(p.path || p.file || p.slug)) {
        return fail(tool + ' requires path or slug', 'Pass path or project slug.');
      }
      break;
    case 'create_document':
    case 'create_pdf':
      if (!p.title || p.content == null) {
        return fail(
          tool + ' requires title and content',
          'Pass title (string) and content (string).',
        );
      }
      break;
    case 'git_commit':
      if (!p.message) {
        return fail('git_commit requires message', 'Pass a concise commit message.');
      }
      break;
    case 'git_clone':
    case 'repo_open':
      if (!(p.url || p.repo || p.remote)) {
        return fail(tool + ' requires url', 'Pass a git remote URL.');
      }
      break;
    case 'create_pull_request':
      if (!p.title) {
        return fail('create_pull_request requires title', 'Pass a PR title.');
      }
      break;
    case 'get_pull_request':
    case 'review_pull_request':
      if (!(p.number || p.pr || p.pull)) {
        return fail(tool + ' requires number', 'Pass the PR number.');
      }
      break;
    case 'use_skill':
    case 'skill_view':
      if (!p.name) {
        return fail(tool + ' requires name', 'Pass a known skill name from list_skills.');
      }
      break;
    case 'plan':
      if (!p.steps) {
        return fail('plan requires steps', 'Pass steps as a string or structured list.');
      }
      break;
    case 'copy_file':
      if (!(p.src || p.source) || !(p.dest || p.destination)) {
        return fail(
          'copy_file requires src and dest',
          'Pass src and dest workspace paths.',
        );
      }
      break;
    case 'find_files':
    case 'search_code':
      if (!(p.pattern || p.query || p.needle)) {
        return fail(
          tool + ' requires pattern',
          'Pass pattern (or query/needle). Prefer this over shell grep/find.',
        );
      }
      break;
    case 'run_javascript':
    case 'run_python':
      if (!(p.code || p.source)) {
        return fail(tool + ' requires code', 'Pass code as a string.');
      }
      break;
    case 'execute_code':
      if (!(p.code || p.source) || !p.language) {
        return fail(
          'execute_code requires language and code',
          'Pass language: javascript|python|shell and code.',
        );
      }
      break;
    case 'patch_file':
      if (!(p.path || p.file) || !(p.patch || p.diff || p.old_string || p.content)) {
        return fail(
          'patch_file requires path and patch content',
          'Pass path plus patch/diff/old_string+new_string.',
        );
      }
      break;
    case 'apply_patch':
      if (!(p.patch || p.diff || p.input)) {
        return fail(
          'apply_patch requires patch',
          'Pass a V4A patch string (*** Begin Patch … *** End Patch).',
        );
      }
      break;
    case 'delegate_task':
      if (
        !(p.goal || p.task || p.prompt) &&
        !(Array.isArray(p.goals) && p.goals.length)
      ) {
        return fail(
          'delegate_task requires goal or goals[]',
          'Pass goal (and optional agent=explore|general|verify) or goals:[{goal,agent}].',
        );
      }
      break;
    case 'http_request':
    case 'fetch_url':
    case 'web_extract':
      if (!p.url) {
        return fail(tool + ' requires url', 'Pass a public http(s) URL.');
      }
      break;
    case 'search_web':
      if (!(p.query || (Array.isArray(p.queries) && p.queries.length))) {
        return fail(
          'search_web requires query or queries[]',
          'Pass query string or queries array (max 3).',
        );
      }
      break;
    default:
      break;
  }
  return { ok: true, tool };
}

module.exports = {
  resolveWorkspacePath,
  normalizeAbs,
  collapseProjectDoublePath,
  stripRedundantProjectPrefix,
  coerceVirtualAbs,
  suggestSimilarPaths,
  pathMissResult,
  ensureParentDirs,
  toolParamsLookValid,
  validateToolCall,
};
