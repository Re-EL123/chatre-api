'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ALLOWED_BINARIES = new Set([
  'ls',
  'pwd',
  'cat',
  'echo',
  'mkdir',
  'touch',
  'rm',
  'cp',
  'mv',
  'find',
  'grep',
  'head',
  'tail',
  'wc',
  'sort',
  'tree',
  'node',
  'python3',
  'python',
  'git',
  'npm',
  'npx',
  'bash',
  'sh',
]);

function materialize(files, rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  const entries = Object.values(files || {}).sort(
    (a, b) => a.path.length - b.path.length,
  );
  for (const entry of entries) {
    if (!entry || !entry.path || entry.path === '/') continue;
    const abs = path.join(rootDir, entry.path.replace(/^\//, ''));
    if (entry.type === 'dir') {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, entry.content || '', 'utf8');
    }
  }
}

function collect(rootDir) {
  const out = {
    '/': { path: '/', type: 'dir', children: [] },
  };

  function walk(abs, virt) {
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch {
      return;
    }
    out[virt] = out[virt] || { path: virt, type: 'dir', children: [] };
    out[virt].children = [];
    for (const name of names) {
      if (name === '.git' && virt === '/') {
        // keep git; include it
      }
      const childAbs = path.join(abs, name);
      const childVirt = virt === '/' ? '/' + name : virt + '/' + name;
      let st;
      try {
        st = fs.statSync(childAbs);
      } catch {
        continue;
      }
      out[virt].children.push(name);
      if (st.isDirectory()) {
        out[childVirt] = { path: childVirt, type: 'dir', children: [] };
        walk(childAbs, childVirt);
      } else {
        let content = '';
        try {
          // Cap file size readback
          if (st.size <= 512 * 1024) {
            content = fs.readFileSync(childAbs, 'utf8');
          } else {
            content = fs.readFileSync(childAbs, 'utf8').slice(0, 512 * 1024);
          }
        } catch {
          content = '';
        }
        out[childVirt] = {
          path: childVirt,
          type: 'file',
          content,
        };
      }
    }
  }

  walk(rootDir, '/');
  // Ensure top-level children on /
  try {
    out['/'].children = fs.readdirSync(rootDir);
  } catch {
    out['/'].children = [];
  }
  return out;
}

function resolveCwd(rootDir, cwd) {
  const rel = String(cwd || '/home/user').replace(/^\//, '');
  const abs = path.join(rootDir, rel);
  if (!abs.startsWith(rootDir)) return rootDir;
  return abs;
}

function parseCommand(cmd) {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) return { ok: false, error: 'Empty command' };
  if (/[;&|<>`$]/.test(trimmed) && !trimmed.startsWith('node -e ')) {
    // Allow simple pipes? Keep strict for safety on shared hosting.
    if (/[;&<>`]/.test(trimmed)) {
      return { ok: false, error: 'Shell metacharacters are not allowed' };
    }
  }
  // naive argv split respecting simple quotes
  const args = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) args.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) args.push(cur);
  const bin = args[0];
  if (!ALLOWED_BINARIES.has(bin)) {
    return {
      ok: false,
      error:
        'Command not allowed: ' +
        bin +
        '. Allowed: ' +
        [...ALLOWED_BINARIES].join(', '),
    };
  }
  return { ok: true, bin, args: args.slice(1), raw: trimmed };
}

/**
 * Run a command against a Firestore-backed virtual FS by materializing to /tmp.
 */
function runInTempWorkspace({ files, cwd, command, timeoutMs }) {
  const parsed = parseCommand(command);
  if (!parsed.ok) {
    return { ok: false, output: '', error: parsed.error, files, cwd };
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatre-ws-'));
  try {
    materialize(files, rootDir);
    const workCwd = resolveCwd(rootDir, cwd);
    fs.mkdirSync(workCwd, { recursive: true });

    let result;
    if (parsed.bin === 'bash' || parsed.bin === 'sh') {
      const script = parsed.args.join(' ');
      result = spawnSync(parsed.bin, ['-lc', script], {
        cwd: workCwd,
        encoding: 'utf8',
        timeout: timeoutMs || 20000,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(rootDir, 'home', 'user'),
          LANG: 'C.UTF-8',
        },
        maxBuffer: 2 * 1024 * 1024,
      });
    } else {
      result = spawnSync(parsed.bin, parsed.args, {
        cwd: workCwd,
        encoding: 'utf8',
        timeout: timeoutMs || 20000,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(rootDir, 'home', 'user'),
          LANG: 'C.UTF-8',
        },
        maxBuffer: 2 * 1024 * 1024,
      });
    }

    const output = String(result.stdout || '') + String(result.stderr || '');
    const nextFiles = collect(rootDir);
    const relCwd = path.relative(rootDir, workCwd);
    const nextCwd = '/' + (relCwd ? relCwd.split(path.sep).join('/') : '');

    return {
      ok: result.status === 0,
      code: result.status,
      output: output.slice(0, 100000),
      error: result.error ? String(result.error.message || result.error) : null,
      files: nextFiles,
      cwd: nextCwd === '/' ? '/home/user' : nextCwd || cwd,
    };
  } finally {
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  runInTempWorkspace,
  materialize,
  collect,
  ALLOWED_BINARIES,
};
