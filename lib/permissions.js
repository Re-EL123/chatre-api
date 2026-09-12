'use strict';

/**
 * Permission rulesets — OpenCode-inspired allow / ask / deny
 * with tool names, categories, and path globs.
 *
 * Rule shape: { permission, pattern, action }
 * - permission: tool name OR category (edit|read|bash|task|todowrite|external_directory|env_secret|*)
 * - pattern: "*" or path/tool glob (supports * and **)
 * - action: allow | ask | deny
 *
 * First matching rule of highest specificity wins; denies beat asks beat allows
 * when specificity is equal (evaluated as: collect matches, pick deny > ask > allow
 * among best-specificity matches).
 */

const EDIT_TOOLS = new Set([
  'write_file',
  'append_file',
  'delete_file',
  'copy_file',
  'create_directory',
  'patch_file',
  'apply_patch',
  'create_document',
  'create_pdf',
  'upload_artifact',
  'image_generate',
  'text_to_speech',
  'csv_write',
  'git_init',
  'git_add',
  'git_commit',
  'git_push',
  'git_clone',
  'repo_open',
  'create_pull_request',
  'review_pull_request',
]);

const READ_TOOLS = new Set([
  'read_file',
  'list_directory',
  'view_tree',
  'find_files',
  'search_code',
  'export_document',
  'verify_project',
  'preview_project',
  'csv_read',
  'csv_query',
  'git_status',
  'git_log',
  'git_diff',
  'repo_diagnostics',
  'list_pull_requests',
  'get_pull_request',
  'get_ci_status',
]);

const BASH_TOOLS = new Set([
  'execute_command',
  'execute_code',
  'run_javascript',
  'run_python',
  'process_manage',
  'shell_open',
  'shell_write',
  'shell_read',
  'shell_close',
  'desktop_exec',
  'run_tests',
]);

const TASK_TOOLS = new Set(['delegate_task']);
const TODO_TOOLS = new Set(['todo', 'todo_write']);

function escapeRegex(s) {
  return String(s).replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  const g = String(glob || '*');
  if (g === '*') return /^[\s\S]*$/;
  // ** = any path segment(s), * = within segment
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += escapeRegex(ch);
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

function pathFromParams(tool, params) {
  const p = params || {};
  return (
    p.path ||
    p.file ||
    p.dest ||
    p.dest_dir ||
    p.cwd ||
    (Array.isArray(p.paths) ? p.paths[0] : null) ||
    null
  );
}

function isEnvSecretPath(filePath) {
  const base = String(filePath || '')
    .split('/')
    .pop() || '';
  if (base === '.env.example' || base === '.env.sample') return false;
  return (
    base === '.env' ||
    /^\.env\./i.test(base) ||
    /\.pem$/i.test(base) ||
    /\.key$/i.test(base) ||
    /credentials\.json$/i.test(base) ||
    /secrets?\.json$/i.test(base)
  );
}

function isExternalPath(filePath, projectRoot) {
  const p = String(filePath || '');
  if (!p) return false;
  if (p.indexOf('/home/user/') !== 0 && p.charAt(0) === '/') return true;
  if (!projectRoot) return false;
  const root = String(projectRoot).replace(/\/$/, '');
  if (p === root || p.indexOf(root + '/') === 0) return false;
  // Allow shared workspace roots
  if (
    p.indexOf('/home/user/documents/') === 0 ||
    p.indexOf('/home/user/uploads/') === 0 ||
    p.indexOf('/home/user/downloads/') === 0 ||
    p === '/home/user/readme.txt'
  ) {
    return false;
  }
  if (p.indexOf('/home/user/projects/') === 0) {
    // other projects = external relative to active
    return true;
  }
  return p.indexOf('/home/user/') !== 0;
}

function categoriesFor(tool) {
  const t = String(tool || '');
  const cats = [];
  if (EDIT_TOOLS.has(t)) cats.push('edit');
  if (READ_TOOLS.has(t)) cats.push('read');
  if (BASH_TOOLS.has(t)) cats.push('bash');
  if (TASK_TOOLS.has(t)) cats.push('task');
  if (TODO_TOOLS.has(t)) cats.push('todowrite');
  return cats;
}

function specificity(rule) {
  const perm = String(rule.permission || '*');
  const pat = String(rule.pattern || '*');
  let score = 0;
  if (perm !== '*') score += 100;
  if (pat !== '*') score += 10 + Math.min(40, pat.replace(/\*/g, '').length);
  return score;
}

function actionRank(action) {
  if (action === 'deny') return 3;
  if (action === 'ask') return 2;
  return 1; // allow
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const action = String(rule.action || 'allow').toLowerCase();
  if (['allow', 'ask', 'deny'].indexOf(action) < 0) return null;
  return {
    permission: String(rule.permission || '*'),
    pattern: String(rule.pattern != null ? rule.pattern : '*'),
    action: action,
  };
}

function fromConfig(config) {
  const out = [];
  if (!config || typeof config !== 'object') return out;
  // Flat: { write_file: 'deny', edit: { '*': 'deny', '**/plans/*.md': 'allow' } }
  Object.keys(config).forEach((key) => {
    const val = config[key];
    if (val == null) return;
    if (typeof val === 'string') {
      const r = normalizeRule({
        permission: key,
        pattern: '*',
        action: val,
      });
      if (r) out.push(r);
      return;
    }
    if (typeof val === 'object') {
      Object.keys(val).forEach((pat) => {
        const r = normalizeRule({
          permission: key,
          pattern: pat,
          action: val[pat],
        });
        if (r) out.push(r);
      });
    }
  });
  return out;
}

function merge(...sets) {
  const out = [];
  sets.forEach((s) => {
    (s || []).forEach((r) => {
      const n = normalizeRule(r);
      if (n) out.push(n);
    });
  });
  return out;
}

/**
 * Evaluate tool call against ruleset.
 * @returns {{ action: 'allow'|'ask'|'deny', reason: string, matched: object|null }}
 */
function evaluate(tool, params, ruleset, opts) {
  const o = opts || {};
  const t = String(tool || '');
  const filePath = pathFromParams(t, params);
  const projectRoot = o.projectRoot || null;
  const subjects = [t, ...categoriesFor(t), '*'];

  if (filePath && isEnvSecretPath(filePath)) {
    subjects.push('env_secret');
  }
  if (filePath && isExternalPath(filePath, projectRoot)) {
    subjects.push('external_directory');
  }

  const rules = (ruleset || []).map(normalizeRule).filter(Boolean);
  let best = null;
  rules.forEach((rule) => {
    if (subjects.indexOf(rule.permission) < 0 && rule.permission !== t) {
      // also allow permission === tool
      if (rule.permission !== t) return;
    }
    const patternTarget =
      rule.permission === 'external_directory' ||
      rule.permission === 'env_secret' ||
      rule.permission === 'edit' ||
      rule.permission === 'read' ||
      EDIT_TOOLS.has(rule.permission) ||
      READ_TOOLS.has(rule.permission)
        ? String(filePath || '*')
        : t;
    const re = globToRegExp(rule.pattern);
    if (!re.test(patternTarget) && rule.pattern !== '*') {
      // For non-path tools, match tool name against pattern
      if (!globToRegExp(rule.pattern).test(t) && rule.pattern !== '*') return;
    }
    if (rule.pattern !== '*' && filePath) {
      if (!re.test(filePath) && !globToRegExp(rule.pattern).test(t)) return;
    }
    const score = specificity(rule);
    if (
      !best ||
      score > best.score ||
      (score === best.score && actionRank(rule.action) > actionRank(best.rule.action))
    ) {
      best = { rule, score };
    }
  });

  // Built-in secret safeguard if no explicit env rule matched
  if (filePath && isEnvSecretPath(filePath)) {
    const envRule = rules.find(
      (r) =>
        r.permission === 'env_secret' ||
        (r.permission === 'read' && /\.env/.test(r.pattern)),
    );
    if (!envRule && (!best || best.rule.action === 'allow')) {
      return {
        action: 'ask',
        reason: 'Secret/dotenv path requires approval: ' + filePath,
        matched: { permission: 'env_secret', pattern: filePath, action: 'ask' },
      };
    }
  }

  if (!best) {
    return { action: 'allow', reason: 'no matching rule', matched: null };
  }
  return {
    action: best.rule.action,
    reason:
      best.rule.permission +
      ':' +
      best.rule.pattern +
      ' → ' +
      best.rule.action,
    matched: best.rule,
  };
}

/**
 * Parent denials + external_directory rules flow into subagent sessions.
 * Nested task/todowrite denied unless the subagent explicitly allows them.
 */
function deriveSubagentSessionPermission(parentRules, subagentRules) {
  const parent = parentRules || [];
  const child = subagentRules || [];
  const inherited = parent.filter(
    (r) =>
      r &&
      (r.permission === 'external_directory' ||
        r.permission === 'env_secret' ||
        r.action === 'deny'),
  );
  const canTask = child.some(
    (r) => r.permission === 'task' && r.action !== 'deny',
  );
  const canTodo = child.some(
    (r) =>
      (r.permission === 'todowrite' || r.permission === 'todo') &&
      r.action !== 'deny',
  );
  const extras = [];
  if (!canTodo) {
    extras.push({ permission: 'todowrite', pattern: '*', action: 'deny' });
  }
  if (!canTask) {
    extras.push({ permission: 'task', pattern: '*', action: 'deny' });
  }
  return merge(inherited, child, extras);
}

const DEFAULT_WHITELIST_DIRS = [
  '/home/user/projects/**',
  '/home/user/documents/**',
  '/home/user/uploads/**',
  '/home/user/downloads/**',
  '/tmp/**',
];

function defaultRuleset() {
  return fromConfig({
    '*': 'allow',
    env_secret: { '*': 'ask' },
    external_directory: {
      '*': 'ask',
      ...Object.fromEntries(DEFAULT_WHITELIST_DIRS.map((d) => [d, 'allow'])),
    },
    read: {
      '*.env': 'ask',
      '*.env.*': 'ask',
      '*.env.example': 'allow',
      '*.pem': 'ask',
      '*.key': 'ask',
    },
    git_push: 'ask',
    desktop_exec: 'ask',
  });
}

module.exports = {
  EDIT_TOOLS,
  READ_TOOLS,
  BASH_TOOLS,
  TASK_TOOLS,
  TODO_TOOLS,
  fromConfig,
  merge,
  evaluate,
  deriveSubagentSessionPermission,
  defaultRuleset,
  pathFromParams,
  isEnvSecretPath,
  isExternalPath,
  globToRegExp,
  categoriesFor,
};
