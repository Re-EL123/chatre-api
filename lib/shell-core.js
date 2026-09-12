'use strict';

/**
 * Shared shell primitives: allowlists, parse, materialize, sync runner.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE_BINARIES = [
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
  'which',
  'test',
  'true',
  'false',
  'printf',
  'tee',
  'xargs',
  'sed',
  'awk',
  'tr',
  'cut',
  'uniq',
  'diff',
  'stat',
  'curl',
  'wget',
  'ping',
  'env',
  'date',
  'sleep',
  'uname',
  'hostname',
  'base64',
  'md5sum',
  'sha256sum',
  'tar',
  'zip',
  'unzip',
];

const TOOLING_PACK = [
  'rg',
  'jq',
  'make',
  'cargo',
  'go',
  'rustc',
  'gcc',
  'g++',
  'clang',
  'yarn',
  'pnpm',
  'pip',
  'pip3',
  'pytest',
  'tsc',
  'eslint',
];

const ALLOWED_BY_PACK = {
  base: BASE_BINARIES,
  tooling: TOOLING_PACK,
};

const ALLOWED_BINARIES = new Set([...BASE_BINARIES, ...TOOLING_PACK]);

function allowedSet(pack) {
  if (pack === 'base') return new Set(BASE_BINARIES);
  // default: base + tooling
  return ALLOWED_BINARIES;
}

function materialize(files, rootDir, opts) {
  const skipExistingDirs = (opts && opts.skipExistingDirs) || [];
  fs.mkdirSync(rootDir, { recursive: true });
  const entries = Object.values(files || {}).sort(
    (a, b) => a.path.length - b.path.length,
  );
  for (const entry of entries) {
    if (!entry || !entry.path || entry.path === '/') continue;
    const abs = path.join(rootDir, entry.path.replace(/^\//, ''));
    const parts = entry.path.replace(/^\//, '').split('/');
    // Skip rewriting inside preserved dirs if they already exist
    if (
      parts.length > 1 &&
      skipExistingDirs.includes(parts[0]) &&
      fs.existsSync(path.join(rootDir, parts[0]))
    ) {
      continue;
    }
    if (entry.type === 'dir') {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Don't clobber huge generated trees from prior runs if content empty marker
      if (
        parts[0] === 'node_modules' &&
        fs.existsSync(abs) &&
        skipExistingDirs.includes('node_modules')
      ) {
        continue;
      }
      const encoding = entry.encoding === 'base64' ? 'base64' : 'utf8';
      // Never write empty content over an existing non-empty file
      if (
        encoding === 'utf8' &&
        !(entry.content && String(entry.content).length) &&
        fs.existsSync(abs)
      ) {
        try {
          if (fs.statSync(abs).size > 0) continue;
        } catch {
          /* write below */
        }
      }
      if (encoding === 'base64') {
        fs.writeFileSync(abs, Buffer.from(entry.content || '', 'base64'));
      } else {
        fs.writeFileSync(abs, entry.content || '', 'utf8');
      }
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
      // Keep node_modules on disk but don't re-ingest into Firestore (too large)
      if (name === 'node_modules' || name === '.git') {
        out[virt].children.push(name);
        out[virt === '/' ? '/' + name : virt + '/' + name] = {
          path: virt === '/' ? '/' + name : virt + '/' + name,
          type: 'dir',
          children: [],
          stub: true,
        };
        continue;
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
        const { readDiskFileEntry } = require('./workspace-sync');
        out[childVirt] = readDiskFileEntry(childAbs, childVirt, st);
      }
    }
  }

  walk(rootDir, '/');
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

function splitArgv(trimmed) {
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
  return args;
}

function firstBinary(segment) {
  const args = splitArgv(String(segment || '').trim());
  return args[0] || '';
}

function parseCommand(cmd, opts) {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) return { ok: false, error: 'Empty command' };
  const allow = allowedSet(opts && opts.pack);

  if (/`/.test(trimmed) || /\$\(/g.test(trimmed)) {
    return { ok: false, error: 'Command substitution is not allowed' };
  }

  // Dangerous local-destruction patterns
  if (/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\b/.test(trimmed)) {
    return { ok: false, error: 'Refusing rm targeting /' };
  }

  if (/[;&|<>]/.test(trimmed) && !/^(bash|sh)\s/.test(trimmed)) {
    const firstSeg = trimmed.split(/[;&|]/)[0];
    const bin = firstBinary(firstSeg);
    if (bin === 'cd') {
      /* ok */
    } else if (bin && !allow.has(bin)) {
      return {
        ok: false,
        error:
          'Command not allowed: ' +
          bin +
          '. Allowed packs: base+tooling',
      };
    }
    return { ok: true, bin: 'bash', args: ['-lc', trimmed], raw: trimmed };
  }

  const args = splitArgv(trimmed);
  const bin = args[0];
  if (!allow.has(bin)) {
    return {
      ok: false,
      error: 'Command not allowed: ' + bin,
    };
  }
  return { ok: true, bin, args: args.slice(1), raw: trimmed };
}

function runInTempWorkspaceSync({ files, cwd, command, timeoutMs, workspaceId }) {
  const parsed = parseCommand(command);
  if (!parsed.ok) {
    return { ok: false, output: '', error: parsed.error, files, cwd };
  }

  const useCache = !!workspaceId;
  const rootDir = useCache
    ? (() => {
        const dir = path.join(
          os.tmpdir(),
          'chatre-ws-cache',
          String(workspaceId).replace(/[^a-zA-Z0-9_-]/g, '_'),
        );
        fs.mkdirSync(dir, { recursive: true });
        materialize(files, dir, { skipExistingDirs: ['node_modules', '.git'] });
        return dir;
      })()
    : fs.mkdtempSync(path.join(os.tmpdir(), 'chatre-ws-'));

  try {
    const workCwd = resolveCwd(rootDir, cwd);
    fs.mkdirSync(workCwd, { recursive: true });

    let result;
    if (parsed.bin === 'bash' || parsed.bin === 'sh') {
      let script;
      if (parsed.args[0] === '-lc' || parsed.args[0] === '-c') {
        script = parsed.args.slice(1).join(' ');
      } else {
        script = parsed.args.join(' ');
      }
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
      durationMs: null,
      mode: 'workspace',
    };
  } finally {
    if (!useCache) {
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  ALLOWED_BINARIES,
  ALLOWED_BY_PACK,
  BASE_BINARIES,
  TOOLING_PACK,
  materialize,
  collect,
  resolveCwd,
  parseCommand,
  splitArgv,
  runInTempWorkspaceSync,
  allowedSet,
};
