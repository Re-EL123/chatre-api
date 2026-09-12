'use strict';

/**
 * Repo-native git/rg helpers — Cursor-core Phase 1.
 * Working tree syncs via collect(); .git stays on disk in workspace cache.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureCache, collect } = require('./shell-runner');
const Sync = require('./workspace-sync');

const MAX_OUT = 80 * 1024;

function ensureRepoCache(ctx) {
  if (!ctx || !ctx.workspaceId) {
    throw new Error('workspaceId required for repo cache');
  }
  return ensureCache(ctx.workspaceId, ctx.files || {});
}

function virtToAbs(rootDir, virtPath) {
  const v = String(virtPath || '/home/user').replace(/\/+/g, '/');
  const rel = v.replace(/^\//, '');
  const abs = path.join(rootDir, rel);
  if (!abs.startsWith(rootDir)) {
    throw new Error('path escapes workspace');
  }
  return abs;
}

function absToVirt(rootDir, absPath) {
  const rel = path.relative(rootDir, absPath);
  if (!rel || rel.startsWith('..')) return '/';
  return '/' + rel.split(path.sep).join('/');
}

function runCmd(bin, args, opts) {
  const o = opts || {};
  const res = spawnSync(bin, args, {
    cwd: o.cwd,
    encoding: 'utf8',
    timeout: o.timeoutMs || 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C.UTF-8',
    }),
  });
  const stdout = String(res.stdout || '');
  const stderr = String(res.stderr || '');
  const code = res.status == null ? (res.error ? 1 : 0) : res.status;
  let out = (stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')).trim();
  let truncated = false;
  if (out.length > MAX_OUT) {
    out =
      out.slice(0, MAX_OUT / 2) +
      '\n…[truncated]…\n' +
      out.slice(-MAX_OUT / 2);
    truncated = true;
  }
  return {
    ok: code === 0,
    code: code,
    output: out,
    stdout: stdout,
    stderr: stderr,
    truncated: truncated,
    error: res.error
      ? String(res.error.message || res.error)
      : code !== 0
        ? out.slice(0, 400)
        : null,
  };
}

function projectRootVirt(ctx) {
  if (ctx && ctx.repo && ctx.repo.root) return ctx.repo.root;
  if (ctx && ctx.activeProject) {
    return '/home/user/projects/' + ctx.activeProject;
  }
  return '/home/user';
}

function hasRealGit(ctx, rootVirt) {
  try {
    const rootDir = ensureRepoCache(ctx);
    const abs = virtToAbs(rootDir, rootVirt || projectRootVirt(ctx));
    return fs.existsSync(path.join(abs, '.git'));
  } catch {
    return false;
  }
}

function isRepoMode(ctx) {
  return !!(ctx && ctx.repo && ctx.repo.mode === 'git') || hasRealGit(ctx);
}

function slugFromUrl(url) {
  const s = String(url || '')
    .trim()
    .replace(/\.git$/i, '');
  const m = s.match(/([^/:]+)\/?$/);
  let slug = (m && m[1]) || 'repo';
  slug = slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'repo';
}

function runGit(ctx, args, cwdVirt) {
  const rootDir = ensureRepoCache(ctx);
  const cwd = virtToAbs(rootDir, cwdVirt || projectRootVirt(ctx));
  if (!fs.existsSync(cwd)) {
    return {
      ok: false,
      code: 1,
      output: '',
      error: 'cwd missing: ' + (cwdVirt || ''),
    };
  }
  return runCmd('git', args, { cwd: cwd, timeoutMs: 120000 });
}

function runRg(ctx, pattern, pathVirt) {
  const rootDir = ensureRepoCache(ctx);
  const scopeVirt = pathVirt || projectRootVirt(ctx);
  const cwd = virtToAbs(rootDir, scopeVirt);
  if (!fs.existsSync(cwd)) {
    return { ok: false, output: '', error: 'path missing', hits: [] };
  }
  let res = runCmd(
    'rg',
    ['-n', '--no-heading', '--color', 'never', '-S', String(pattern), '.'],
    { cwd: cwd, timeoutMs: 60000 },
  );
  if (res.error && /ENOENT|not found/i.test(String(res.error))) {
    res = runCmd(
      'grep',
      [
        '-RIn',
        '--exclude-dir=.git',
        '--exclude-dir=node_modules',
        String(pattern),
        '.',
      ],
      { cwd: cwd, timeoutMs: 60000 },
    );
  }
  const lines = String(res.stdout || res.output || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 80)
    .map((l) => {
      if (l.startsWith('./')) l = l.slice(2);
      const prefix = scopeVirt.replace(/\/$/, '');
      if (/^[A-Za-z0-9_./-]+:\d+:/.test(l)) {
        return prefix + '/' + l;
      }
      return l;
    });
  return {
    ok: true,
    output: lines.join('\n') || '(no matches)',
    hits: lines.length,
    truncated: !!res.truncated,
  };
}

function parseStatusPorcelain(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  const entries = lines.map((l) => {
    const code = l.slice(0, 2);
    const file = l.slice(3).trim();
    return { code: code, path: file };
  });
  return { dirty: entries.length, entries: entries.slice(0, 100) };
}

function repoStatus(ctx) {
  const root = projectRootVirt(ctx);
  if (!hasRealGit(ctx, root)) {
    return {
      ok: false,
      mode: 'none',
      root: root,
      error: 'No real git repo on disk — use git_clone or git_init',
    };
  }
  const branchRes = runGit(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const headRes = runGit(ctx, ['rev-parse', '--short', 'HEAD'], root);
  const stRes = runGit(ctx, ['status', '--porcelain=v1'], root);
  const logRes = runGit(ctx, ['log', '-1', '--oneline'], root);
  const remoteRes = runGit(ctx, ['remote', 'get-url', 'origin'], root);
  const parsed = parseStatusPorcelain(stRes.stdout || stRes.output);
  const branch =
    (branchRes.stdout || '').trim() ||
    (ctx.repo && ctx.repo.branch) ||
    'main';
  const head = (headRes.stdout || '').trim() || null;
  const remoteUrl =
    (remoteRes.ok && (remoteRes.stdout || '').trim()) ||
    (ctx.repo && ctx.repo.remoteUrl) ||
    null;
  if (ctx.repo) {
    ctx.repo.branch = branch;
    ctx.repo.head = head;
    ctx.repo.remoteUrl = remoteUrl;
    ctx.repo.dirty = parsed.dirty;
  }
  return {
    ok: true,
    mode: 'git',
    root: root,
    branch: branch,
    head: head,
    remoteUrl: remoteUrl,
    dirty: parsed.dirty,
    entries: parsed.entries,
    tip: (logRes.stdout || '').trim() || null,
    text:
      branch +
      (head ? ' @ ' + head : '') +
      (parsed.dirty ? ' · ' + parsed.dirty + ' dirty' : ' · clean'),
  };
}

function repoDiff(ctx, opts) {
  const o = opts || {};
  const root = projectRootVirt(ctx);
  if (!hasRealGit(ctx, root)) {
    return { ok: false, error: 'No real git repo', output: '' };
  }
  const args = o.cached ? ['diff', '--cached'] : ['diff'];
  if (o.path) args.push('--', String(o.path).replace(/^\//, ''));
  const res = runGit(ctx, args, root);
  return {
    ok: true,
    output: res.output || '(empty diff)',
    truncated: !!res.truncated,
    cached: !!o.cached,
  };
}

function syncCollect(ctx) {
  const rootDir = ensureRepoCache(ctx);
  const collected = collect(rootDir);
  const before = ctx.files || {};
  ctx.files = Sync.mergeCollectedFiles(before, collected);
  return ctx.files;
}

function gitClone(ctx, params) {
  const p = params || {};
  const url = String(p.url || p.repo || p.remote || '').trim();
  if (!url) return { ok: false, error: 'url required' };
  if (!/^https?:\/\//i.test(url) && !/^git@/i.test(url)) {
    return { ok: false, error: 'Only http(s) or git@ remotes allowed' };
  }
  const slug =
    String(p.slug || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || slugFromUrl(url);
  const branch = p.branch ? String(p.branch) : null;
  const rootVirt = '/home/user/projects/' + slug;
  const rootDir = ensureRepoCache(ctx);
  const projectsAbs = virtToAbs(rootDir, '/home/user/projects');
  fs.mkdirSync(projectsAbs, { recursive: true });
  const destAbs = virtToAbs(rootDir, rootVirt);

  if (fs.existsSync(path.join(destAbs, '.git'))) {
    runCmd('git', ['fetch', '--depth', '1', 'origin'], {
      cwd: destAbs,
      timeoutMs: 180000,
    });
    if (branch) {
      runCmd('git', ['checkout', branch], { cwd: destAbs, timeoutMs: 60000 });
    }
    ctx.repo = {
      mode: 'git',
      remoteUrl: url,
      root: rootVirt,
      branch: branch || 'main',
    };
    ctx.activeProject = slug;
    ctx.cwd = rootVirt;
    ctx.lockActiveProject = true;
    syncCollect(ctx);
    const st = repoStatus(ctx);
    if (st.ok) {
      ctx.repo.branch = st.branch;
      ctx.repo.head = st.head;
      ctx.repo.dirty = st.dirty;
    }
    return {
      ok: true,
      refreshed: true,
      path: rootVirt,
      slug: slug,
      repo: ctx.repo,
      text: 'Refreshed repo at ' + rootVirt + ' (' + (st.text || '') + ')',
      status: st,
    };
  }

  if (fs.existsSync(destAbs)) {
    try {
      fs.rmSync(destAbs, { recursive: true, force: true });
    } catch (e) {
      return {
        ok: false,
        error: 'Destination exists and could not be cleared: ' + destAbs,
      };
    }
  }

  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(url, destAbs);
  const clone = runCmd('git', args, {
    cwd: projectsAbs,
    timeoutMs: 300000,
  });
  if (!clone.ok) {
    return {
      ok: false,
      error: clone.error || clone.output || 'git clone failed',
      output: clone.output,
    };
  }

  syncCollect(ctx);
  ctx.activeProject = slug;
  ctx.cwd = rootVirt;
  ctx.lockActiveProject = true;
  ctx.repo = {
    mode: 'git',
    remoteUrl: url,
    root: rootVirt,
    branch: branch || 'main',
  };
  const st = repoStatus(ctx);
  if (st.ok) {
    ctx.repo.branch = st.branch;
    ctx.repo.head = st.head;
    ctx.repo.dirty = st.dirty;
  }
  return {
    ok: true,
    refreshed: false,
    path: rootVirt,
    slug: slug,
    repo: ctx.repo,
    text: 'Cloned ' + url + ' → ' + rootVirt,
    status: st,
    output: (clone.output || '').slice(0, 500),
  };
}

function gitInitReal(ctx, rootVirt) {
  const root = rootVirt || projectRootVirt(ctx);
  const rootDir = ensureRepoCache(ctx);
  const abs = virtToAbs(rootDir, root);
  fs.mkdirSync(abs, { recursive: true });
  const res = runCmd('git', ['init'], { cwd: abs });
  if (!res.ok) return { ok: false, error: res.error || res.output };
  runCmd('git', ['checkout', '-b', 'main'], { cwd: abs });
  ctx.repo = {
    mode: 'git',
    remoteUrl: null,
    root: root,
    branch: 'main',
    head: null,
    dirty: 0,
  };
  syncCollect(ctx);
  return {
    ok: true,
    path: root,
    repo: ctx.repo,
    text: 'Initialized real git at ' + root,
  };
}

function detectTestCommand(ctx) {
  const root = projectRootVirt(ctx);
  const files = ctx.files || {};
  const pkgPath = root + '/package.json';
  const pkg = files[pkgPath];
  if (pkg && pkg.type === 'file' && pkg.content) {
    try {
      const j = JSON.parse(pkg.content);
      const scripts = (j && j.scripts) || {};
      if (scripts.test) return { cmd: 'npm test', kind: 'npm' };
      if (scripts.lint) return { cmd: 'npm run lint', kind: 'lint' };
    } catch {
      /* ignore */
    }
  }
  try {
    const rootDir = ensureRepoCache(ctx);
    const abs = virtToAbs(rootDir, pkgPath);
    if (fs.existsSync(abs)) {
      const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (j.scripts && j.scripts.test) return { cmd: 'npm test', kind: 'npm' };
      if (j.scripts && j.scripts.lint) {
        return { cmd: 'npm run lint', kind: 'lint' };
      }
    }
    if (
      fs.existsSync(virtToAbs(rootDir, root + '/pytest.ini')) ||
      fs.existsSync(virtToAbs(rootDir, root + '/tests'))
    ) {
      return { cmd: 'python3 -m pytest -q', kind: 'pytest' };
    }
  } catch {
    /* ignore */
  }
  const hasHtml = Object.keys(files).some(
    (p) => p.indexOf(root + '/') === 0 && /\.html?$/i.test(p),
  );
  if (hasHtml) return { cmd: null, kind: 'static', skipTests: true };
  return { cmd: 'npm test', kind: 'npm' };
}

function runTests(ctx, params) {
  const p = params || {};
  const detected = detectTestCommand(ctx);
  const cmd = p.cmd || p.command || detected.cmd;
  if (!cmd && detected.skipTests) {
    ctx.testsOk = true;
    ctx.lastTest = {
      ok: true,
      skipped: true,
      kind: 'static',
      text: 'No test script — static project; use preview_project for proof',
      at: new Date().toISOString(),
    };
    return {
      ok: true,
      skipped: true,
      testsOk: true,
      text: ctx.lastTest.text,
      lastTest: ctx.lastTest,
    };
  }
  if (!cmd) {
    return {
      ok: false,
      error: 'No test command detected — pass cmd explicitly',
    };
  }
  const rootDir = ensureRepoCache(ctx);
  const cwd = virtToAbs(rootDir, projectRootVirt(ctx));
  const shell = process.platform === 'win32' ? 'cmd' : 'bash';
  const args = process.platform === 'win32' ? ['/c', cmd] : ['-lc', cmd];
  const res = runCmd(shell, args, {
    cwd: cwd,
    timeoutMs: p.timeoutMs || 180000,
  });
  ctx.testsOk = !!res.ok;
  ctx.lastTest = {
    ok: !!res.ok,
    code: res.code,
    kind: detected.kind,
    cmd: cmd,
    output: (res.output || '').slice(0, 4000),
    at: new Date().toISOString(),
  };
  syncCollect(ctx);
  return {
    ok: !!res.ok,
    testsOk: ctx.testsOk,
    code: res.code,
    cmd: cmd,
    output: ctx.lastTest.output,
    text: res.ok ? 'Tests passed (' + cmd + ')' : 'Tests failed (' + cmd + ')',
    lastTest: ctx.lastTest,
  };
}

function repoDiagnostics(ctx) {
  const rootDir = ensureRepoCache(ctx);
  const cwd = virtToAbs(rootDir, projectRootVirt(ctx));
  const notes = [];
  let ok = true;
  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    const tsc = runCmd('npx', ['--yes', 'tsc', '--noEmit'], {
      cwd: cwd,
      timeoutMs: 120000,
    });
    notes.push({
      tool: 'tsc',
      ok: tsc.ok,
      output: (tsc.output || '').slice(0, 2000),
    });
    if (!tsc.ok) ok = false;
  }
  if (
    fs.existsSync(path.join(cwd, 'node_modules', 'eslint')) ||
    fs.existsSync(path.join(cwd, '.eslintrc.js')) ||
    fs.existsSync(path.join(cwd, 'eslint.config.js'))
  ) {
    const eslint = runCmd(
      'npx',
      ['--yes', 'eslint', '.', '--max-warnings', '0'],
      { cwd: cwd, timeoutMs: 120000 },
    );
    notes.push({
      tool: 'eslint',
      ok: eslint.ok,
      output: (eslint.output || '').slice(0, 2000),
    });
    if (!eslint.ok) ok = false;
  }
  if (!notes.length) {
    return {
      ok: true,
      skipped: true,
      text: 'No tsc/eslint config detected',
      diagnostics: [],
    };
  }
  ctx.lastDiagnostics = {
    ok: ok,
    notes: notes,
    at: new Date().toISOString(),
  };
  return {
    ok: ok,
    diagnostics: notes,
    text: ok ? 'Diagnostics clean' : 'Diagnostics reported issues',
    lastDiagnostics: ctx.lastDiagnostics,
  };
}

function hasTestScript(ctx) {
  const d = detectTestCommand(ctx);
  return !!(d.cmd && !d.skipTests);
}

module.exports = {
  ensureRepoCache,
  virtToAbs,
  absToVirt,
  runCmd,
  runGit,
  runRg,
  projectRootVirt,
  hasRealGit,
  isRepoMode,
  slugFromUrl,
  parseStatusPorcelain,
  repoStatus,
  repoDiff,
  syncCollect,
  gitClone,
  gitInitReal,
  detectTestCommand,
  runTests,
  repoDiagnostics,
  hasTestScript,
};
