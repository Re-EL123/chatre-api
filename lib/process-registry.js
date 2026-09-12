'use strict';

/**
 * Background process registry for agent runs (Hermes process_manage inspired).
 */

const { spawn } = require('child_process');
const path = require('path');
const { ensureCache } = require('./shell-runner');
const { resolveCwd } = require('./shell-core');

const processes = new Map();
const MAX_BUFFER = 200000;

function newId() {
  return 'proc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function startProcess({ workspaceId, files, cwd, command, notify }) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, error: 'command required' };
  const id = newId();
  const rootDir = ensureCache(workspaceId, files || {});
  const workCwd = resolveCwd(rootDir, cwd || '/home/user');
  const child = spawn('bash', ['-lc', cmd], {
    cwd: workCwd,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(rootDir, 'home', 'user'),
      LANG: 'C.UTF-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const state = {
    id,
    command: cmd,
    cwd: cwd || '/home/user',
    workspaceId,
    child,
    buffer: '',
    closed: false,
    exitCode: null,
    createdAt: Date.now(),
    notify: !!notify,
    notified: false,
  };
  function onData(buf) {
    state.buffer += buf.toString('utf8');
    if (state.buffer.length > MAX_BUFFER) {
      state.buffer = state.buffer.slice(-MAX_BUFFER);
    }
  }
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    state.closed = true;
    state.exitCode = code;
  });
  child.on('error', () => {
    state.closed = true;
  });
  processes.set(id, state);
  return {
    ok: true,
    process_id: id,
    command: cmd,
    text:
      'Background process ' +
      id +
      ' started. Use process_manage action=status|read|kill|list|poll.',
  };
}

function get(id) {
  return processes.get(String(id || '')) || null;
}

function listProcesses(workspaceId) {
  const out = [];
  for (const s of processes.values()) {
    if (workspaceId && s.workspaceId !== workspaceId) continue;
    out.push({
      process_id: s.id,
      command: s.command,
      closed: s.closed,
      exitCode: s.exitCode,
      createdAt: s.createdAt,
      buffer_len: s.buffer.length,
    });
  }
  return out;
}

function statusProcess(id) {
  const s = get(id);
  if (!s) return { ok: false, error: 'Unknown process_id' };
  return {
    ok: true,
    process_id: s.id,
    command: s.command,
    closed: s.closed,
    exitCode: s.exitCode,
    running: !s.closed,
    text: s.closed
      ? 'Process exited with code ' + s.exitCode
      : 'Process still running',
  };
}

function readProcess(id, opts) {
  const s = get(id);
  if (!s) return { ok: false, error: 'Unknown process_id' };
  const clear = !!(opts && opts.clear);
  const output = s.buffer;
  if (clear) s.buffer = '';
  return {
    ok: true,
    process_id: s.id,
    closed: s.closed,
    exitCode: s.exitCode,
    output: output.slice(-MAX_BUFFER),
    text: output.slice(-4000) || '(no output yet)',
  };
}

function killProcess(id) {
  const s = get(id);
  if (!s) return { ok: false, error: 'Unknown process_id' };
  try {
    if (!s.closed && s.child) s.child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  s.closed = true;
  return { ok: true, process_id: s.id, text: 'Process killed' };
}

function pollCompleted(workspaceId) {
  const done = [];
  for (const s of processes.values()) {
    if (workspaceId && s.workspaceId !== workspaceId) continue;
    if (s.closed && s.notify && !s.notified) {
      s.notified = true;
      done.push({
        process_id: s.id,
        command: s.command,
        exitCode: s.exitCode,
        output_tail: s.buffer.slice(-2000),
      });
    }
  }
  return { ok: true, completed: done, text: done.length ? JSON.stringify(done) : 'none' };
}

function processManage(action, params, ctx) {
  const a = String(action || params.action || '').toLowerCase();
  const workspaceId = ctx && ctx.workspaceId;
  if (a === 'start' || a === 'run') {
    return startProcess({
      workspaceId,
      files: ctx && ctx.files,
      cwd: params.cwd,
      command: params.command || params.cmd,
      notify: params.notify_on_complete !== false,
    });
  }
  if (a === 'list') {
    const list = listProcesses(workspaceId);
    return { ok: true, processes: list, text: list.length ? JSON.stringify(list) : 'No processes' };
  }
  if (a === 'status') return statusProcess(params.process_id || params.id);
  if (a === 'read') {
    return readProcess(params.process_id || params.id, { clear: !!params.clear });
  }
  if (a === 'kill' || a === 'stop') return killProcess(params.process_id || params.id);
  if (a === 'poll' || a === 'notifications') return pollCompleted(workspaceId);
  return {
    ok: false,
    error: 'Unknown action. Use start|list|status|read|kill|poll',
  };
}

module.exports = {
  processManage,
  startProcess,
  listProcesses,
  statusProcess,
  readProcess,
  killProcess,
  pollCompleted,
};
