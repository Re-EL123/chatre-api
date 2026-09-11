'use strict';

/**
 * Async workspace shell runner with streaming, cancel, truncation, and cache.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  materialize,
  collect,
  parseCommand,
  resolveCwd,
  ALLOWED_BINARIES,
  ALLOWED_BY_PACK,
} = require('./shell-core');

const CACHE_ROOT = path.join(os.tmpdir(), 'chatre-ws-cache');
const MAX_OUTPUT = 100000;
const HEAD_KEEP = 40000;
const TAIL_KEEP = 40000;

const NEEDS_INPUT_RE =
  /(password\s*:|passphrase\s*:|\[Y\/n\]|\(y\/N\)|Enter OTP|verification code|sudo:\s|Username:)/i;

function truncateOutput(text, max) {
  const s = String(text || '');
  const limit = max || MAX_OUTPUT;
  if (s.length <= limit) {
    return { text: s, truncated: false, omitted: 0 };
  }
  const omitted = s.length - HEAD_KEEP - TAIL_KEEP;
  const textOut =
    s.slice(0, HEAD_KEEP) +
    '\n…[truncated ' +
    omitted +
    ' bytes]…\n' +
    s.slice(-TAIL_KEEP);
  return { text: textOut, truncated: true, omitted };
}

function detectNeedsInput(chunk) {
  return NEEDS_INPUT_RE.test(String(chunk || ''));
}

function workspaceCacheDir(workspaceId) {
  const id = String(workspaceId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_ROOT, id);
}

function ensureCache(workspaceId, files) {
  const rootDir = workspaceCacheDir(workspaceId);
  fs.mkdirSync(rootDir, { recursive: true });
  // Preserve node_modules / .git objects across runs
  materialize(files, rootDir, {
    skipExistingDirs: ['node_modules', '.git'],
  });
  return rootDir;
}

function resolveMode(requested) {
  const m = String(requested || process.env.CHATRE_SHELL_MODE || 'workspace')
    .toLowerCase()
    .trim();
  if (m === 'sandbox' || m === 'local' || m === 'workspace') return m;
  return 'workspace';
}

/**
 * Run a command asynchronously with optional streaming.
 * @returns {Promise<object>}
 */
function runWorkspaceCommand({
  files,
  cwd,
  command,
  timeoutMs,
  workspaceId,
  onChunk,
  signal,
  network,
  pack,
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const parsed = parseCommand(command, { pack });
    if (!parsed.ok) {
      return resolve({
        ok: false,
        output: '',
        error: parsed.error,
        files,
        cwd,
        code: null,
        durationMs: 0,
        mode: 'workspace',
        truncated: false,
      });
    }

    let rootDir;
    try {
      rootDir = ensureCache(workspaceId, files || {});
    } catch (err) {
      return resolve({
        ok: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        files,
        cwd,
        durationMs: Date.now() - started,
        mode: 'workspace',
      });
    }

    const workCwd = resolveCwd(rootDir, cwd);
    try {
      fs.mkdirSync(workCwd, { recursive: true });
    } catch {
      /* ignore */
    }

    const env = {
      PATH: process.env.PATH,
      HOME: path.join(rootDir, 'home', 'user'),
      LANG: 'C.UTF-8',
      CHATRE_SHELL: '1',
    };
    if (network === false || process.env.CHATRE_SHELL_NETWORK === '0') {
      // Soft hint — true network block needs sandbox; still useful for scripts
      env.CHATRE_NETWORK = '0';
    }

    let bin = parsed.bin;
    let args = parsed.args;
    if (bin === 'bash' || bin === 'sh') {
      let script;
      if (args[0] === '-lc' || args[0] === '-c') {
        script = args.slice(1).join(' ');
      } else {
        script = args.join(' ');
      }
      bin = parsed.bin;
      args = ['-lc', script];
    }

    const child = spawn(bin, args, {
      cwd: workCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let needsInput = false;
    const softTimeout = Math.min(Number(timeoutMs) || 25000, 180000);

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, softTimeout);

    const onAbort = () => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    function handleChunk(buf, stream) {
      const chunk = buf.toString('utf8');
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (!needsInput && detectNeedsInput(chunk)) needsInput = true;
      if (typeof onChunk === 'function') {
        try {
          onChunk({ stream, chunk, needsInput });
        } catch {
          /* ignore */
        }
      }
    }

    child.stdout.on('data', (b) => handleChunk(b, 'stdout'));
    child.stderr.on('data', (b) => handleChunk(b, 'stderr'));

    child.on('error', (err) => {
      clearTimeout(timer);
      const combined = truncateOutput(stdout + stderr);
      resolve({
        ok: false,
        code: null,
        output: combined.text,
        truncated: combined.truncated,
        omitted: combined.omitted,
        error: err.message || String(err),
        files: collect(rootDir),
        cwd: virtualCwd(rootDir, workCwd, cwd),
        durationMs: Date.now() - started,
        mode: 'workspace',
        killed,
        needs_input: needsInput,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const combined = truncateOutput(stdout + stderr);
      const nextFiles = collect(rootDir);
      resolve({
        ok: !killed && code === 0,
        code,
        output: combined.text,
        truncated: combined.truncated,
        omitted: combined.omitted,
        error: killed
          ? 'Command timed out or cancelled'
          : code === 0
            ? null
            : 'exit ' + code,
        files: nextFiles,
        cwd: virtualCwd(rootDir, workCwd, cwd),
        durationMs: Date.now() - started,
        mode: 'workspace',
        killed,
        needs_input: needsInput,
        command: parsed.raw,
      });
    });
  });
}

function virtualCwd(rootDir, workCwd, fallback) {
  const relCwd = path.relative(rootDir, workCwd);
  const nextCwd = '/' + (relCwd ? relCwd.split(path.sep).join('/') : '');
  return nextCwd === '/' ? '/home/user' : nextCwd || fallback;
}

/** Sync wrapper for callers that still expect spawnSync semantics */
function runInTempWorkspace(opts) {
  // Fire async but block via deasync-like loop is bad; use spawnSync path in shell-core for sync
  const { runInTempWorkspaceSync } = require('./shell-core');
  return runInTempWorkspaceSync(opts);
}

module.exports = {
  runWorkspaceCommand,
  runInTempWorkspace,
  truncateOutput,
  detectNeedsInput,
  resolveMode,
  workspaceCacheDir,
  ensureCache,
  ALLOWED_BINARIES,
  ALLOWED_BY_PACK,
  parseCommand,
  materialize,
  collect,
};
