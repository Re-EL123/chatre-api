'use strict';

/**
 * Layer 3 — Isolated execution via git worktrees (optional).
 * Folded into /api/workspace?action=worktree — no new top-level route.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function run(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
  };
}

function resolveRepoRoot(cwd) {
  const r = run(cwd || process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!r.ok) return null;
  return r.stdout;
}

function listWorktrees(repoRoot) {
  const r = run(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!r.ok) {
    return { ok: false, error: r.stderr || 'worktree list failed', worktrees: [] };
  }
  const items = [];
  let cur = null;
  r.stdout.split('\n').forEach((line) => {
    if (line.startsWith('worktree ')) {
      if (cur) items.push(cur);
      cur = { path: line.slice(9), branch: null, head: null };
    } else if (line.startsWith('HEAD ') && cur) cur.head = line.slice(5);
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7);
  });
  if (cur) items.push(cur);
  return { ok: true, worktrees: items };
}

function createWorktree(repoRoot, opts) {
  const o = opts || {};
  const id = String(o.id || 'agent-' + Date.now())
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 48);
  const branch = String(o.branch || 'chatre/' + id);
  const base = path.join(repoRoot, '.chatre', 'worktrees');
  fs.mkdirSync(base, { recursive: true });
  const dest = path.join(base, id);
  if (fs.existsSync(dest)) {
    return { ok: false, error: 'worktree already exists: ' + dest, path: dest, id };
  }
  const hasBranch = run(repoRoot, ['rev-parse', '--verify', branch]);
  if (!hasBranch.ok) {
    const c = run(repoRoot, ['branch', branch]);
    if (!c.ok) return { ok: false, error: c.stderr || 'branch create failed' };
  }
  const add = run(repoRoot, ['worktree', 'add', dest, branch]);
  if (!add.ok) return { ok: false, error: add.stderr || 'worktree add failed' };
  return {
    ok: true,
    id,
    path: dest,
    branch,
    head: run(dest, ['rev-parse', 'HEAD']).stdout,
  };
}

function removeWorktree(repoRoot, idOrPath) {
  const target = String(idOrPath || '');
  let dest = target;
  if (!path.isAbsolute(dest)) {
    dest = path.join(repoRoot, '.chatre', 'worktrees', target);
  }
  const r = run(repoRoot, ['worktree', 'remove', '--force', dest]);
  if (!r.ok) {
    run(repoRoot, ['worktree', 'prune']);
    return { ok: false, error: r.stderr || 'remove failed', path: dest };
  }
  run(repoRoot, ['worktree', 'prune']);
  return { ok: true, path: dest, remaining: listWorktrees(repoRoot).worktrees };
}

module.exports = {
  resolveRepoRoot,
  listWorktrees,
  createWorktree,
  removeWorktree,
};
