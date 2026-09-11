'use strict';

/**
 * Interactive shell sessions (pipe-based pseudo-PTY) for agent tools.
 * Sessions live in-process for the duration of an agent run / serverless invoke.
 */

const { spawn } = require('child_process');
const path = require('path');
const { ensureCache, detectNeedsInput, truncateOutput } = require('./shell-runner');
const { resolveCwd } = require('./shell-core');

const sessions = new Map();
const MAX_BUFFER = 200000;

function newId() {
  return 'sh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function openSession({ workspaceId, files, cwd, shell }) {
  const id = newId();
  const rootDir = ensureCache(workspaceId, files || {});
  const workCwd = resolveCwd(rootDir, cwd || '/home/user');
  const bin = shell === 'sh' ? 'sh' : 'bash';
  const child = spawn(bin, ['-i'], {
    cwd: workCwd,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(rootDir, 'home', 'user'),
      LANG: 'C.UTF-8',
      PS1: 'chatre$ ',
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = {
    id,
    child,
    rootDir,
    cwd: workCwd,
    workspaceId,
    buffer: '',
    closed: false,
    exitCode: null,
    createdAt: Date.now(),
    needsInput: false,
  };

  function onData(buf) {
    const chunk = buf.toString('utf8');
    state.buffer += chunk;
    if (state.buffer.length > MAX_BUFFER) {
      state.buffer = state.buffer.slice(-MAX_BUFFER);
    }
    if (detectNeedsInput(chunk)) state.needsInput = true;
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

  sessions.set(id, state);
  return {
    ok: true,
    session_id: id,
    cwd: cwd || '/home/user',
    shell: bin,
    text: 'Interactive shell opened. Use shell_write / shell_read / shell_close.',
  };
}

function getSession(id) {
  return sessions.get(String(id || '')) || null;
}

function writeSession(id, data) {
  const s = getSession(id);
  if (!s || s.closed) return { ok: false, error: 'No active shell session' };
  const payload = data == null ? '' : String(data);
  try {
    s.child.stdin.write(payload.endsWith('\n') ? payload : payload + '\n');
    return { ok: true, session_id: id, bytes: Buffer.byteLength(payload) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readSession(id, opts) {
  const s = getSession(id);
  if (!s) return { ok: false, error: 'No such shell session' };
  const waitMs = Math.min(Number(opts && opts.wait_ms) || 200, 5000);
  return new Promise((resolve) => {
    setTimeout(() => {
      const raw = s.buffer;
      s.buffer = '';
      const cut = truncateOutput(raw, Number(opts && opts.max) || 40000);
      resolve({
        ok: true,
        session_id: id,
        output: cut.text,
        truncated: cut.truncated,
        closed: s.closed,
        exitCode: s.exitCode,
        needs_input: s.needsInput,
      });
      s.needsInput = false;
    }, waitMs);
  });
}

function closeSession(id) {
  const s = getSession(id);
  if (!s) return { ok: true, closed: true, session_id: id };
  try {
    s.child.kill('SIGTERM');
    setTimeout(() => {
      try {
        s.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 1500);
  } catch {
    /* ignore */
  }
  sessions.delete(id);
  return { ok: true, closed: true, session_id: id };
}

function listSessions() {
  return [...sessions.values()].map((s) => ({
    session_id: s.id,
    closed: s.closed,
    createdAt: s.createdAt,
  }));
}

module.exports = {
  openSession,
  writeSession,
  readSession,
  closeSession,
  listSessions,
  getSession,
};
