'use strict';

/**
 * Optional Vercel Sandbox execution with workspace re-collect after commands.
 * Enabled when USE_VERCEL_SANDBOX=1 and @vercel/sandbox is installed.
 */

const MAX_COLLECT_FILES = 200;
const MAX_FILE_BYTES = 200000;

async function runInVercelSandbox({ files, cwd, command, timeoutMs }) {
  if (process.env.USE_VERCEL_SANDBOX !== '1') {
    return null;
  }

  let Sandbox;
  try {
    ({ Sandbox } = require('@vercel/sandbox'));
  } catch {
    return {
      ok: false,
      skipped: true,
      error: '@vercel/sandbox not installed',
    };
  }

  const credentials = {};
  if (
    process.env.VERCEL_TOKEN &&
    process.env.VERCEL_TEAM_ID &&
    process.env.VERCEL_PROJECT_ID
  ) {
    credentials.token = process.env.VERCEL_TOKEN;
    credentials.teamId = process.env.VERCEL_TEAM_ID;
    credentials.projectId = process.env.VERCEL_PROJECT_ID;
  }

  const sandbox = await Sandbox.create({
    ...credentials,
    runtime: 'node22',
    timeout: timeoutMs || 120000,
  });

  try {
    await materializeFiles(sandbox, files);

    const work = String(cwd || '/home/user').replace(/^\//, '') || '.';
    await sandbox.runCommand('mkdir', ['-p', work]);
    const result = await sandbox.runCommand('sh', [
      '-lc',
      'cd ' + shellQuote(work) + ' && ' + command,
    ]);
    const stdout = await result.stdout();
    const stderr = await result.stderr();
    const output = String(stdout || '') + String(stderr || '');

    const collected = await collectSandboxFiles(sandbox, files);
    return {
      ok: result.exitCode === 0,
      code: result.exitCode,
      output: output.slice(0, 100000),
      error: result.exitCode === 0 ? null : 'exit ' + result.exitCode,
      sandbox: true,
      files: collected,
      cwd,
      synced: true,
    };
  } finally {
    try {
      await sandbox.stop();
    } catch {
      /* ignore */
    }
  }
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, `'\"'\"'`) + "'";
}

async function materializeFiles(sandbox, files) {
  for (const entry of Object.values(files || {})) {
    if (!entry || !entry.path || entry.path === '/') continue;
    const rel = entry.path.replace(/^\//, '');
    if (entry.type === 'dir') {
      await sandbox.runCommand('mkdir', ['-p', rel]);
    } else {
      const dir = rel.includes('/') ? rel.replace(/\/[^/]+$/, '') : '.';
      if (dir && dir !== '.') {
        await sandbox.runCommand('mkdir', ['-p', dir]);
      }
      const b64 = Buffer.from(entry.content || '', 'utf8').toString('base64');
      await sandbox.runCommand('sh', [
        '-c',
        'echo ' + JSON.stringify(b64) + ' | base64 -d > ' + JSON.stringify(rel),
      ]);
    }
  }
}

/**
 * Re-collect text files from the sandbox into the virtual FS map.
 * Merges over the previous `files` snapshot so dirs/meta survive.
 */
async function collectSandboxFiles(sandbox, previousFiles) {
  const next = { ...(previousFiles || {}) };

  const list = await sandbox.runCommand('sh', [
    '-lc',
    [
      'find . -type f',
      "-not -path './.git/objects/*'",
      "-not -path './node_modules/*'",
      "-not -path './.sandbox/*'",
      '| head -n ' + MAX_COLLECT_FILES,
    ].join(' '),
  ]);
  const listOut = String((await list.stdout()) || '');
  const relPaths = listOut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '.')
    .map((l) => l.replace(/^\.\//, ''));

  for (const rel of relPaths) {
    if (!rel || rel.includes('\0')) continue;
    try {
      const read = await sandbox.runCommand('sh', [
        '-lc',
        'if [ -f ' +
          shellQuote(rel) +
          ' ]; then wc -c < ' +
          shellQuote(rel) +
          '; else echo 0; fi',
      ]);
      const size = parseInt(String((await read.stdout()) || '0').trim(), 10) || 0;
      if (size <= 0 || size > MAX_FILE_BYTES) continue;

      const raw = await sandbox.runCommand('sh', [
        '-lc',
        'base64 -w0 ' + shellQuote(rel) + ' 2>/dev/null || base64 ' + shellQuote(rel),
      ]);
      const b64 = String((await raw.stdout()) || '').replace(/\s+/g, '');
      if (!b64) continue;
      const content = Buffer.from(b64, 'base64').toString('utf8');
      // Skip obvious binary
      if (content.includes('\u0000')) continue;

      const abs = '/' + rel.replace(/^\/+/, '');
      ensureParentDirs(next, abs);
      next[abs] = {
        path: abs,
        type: 'file',
        content,
        updatedAt: new Date().toISOString(),
        syncedFromSandbox: true,
      };
    } catch {
      /* skip unreadable file */
    }
  }

  return next;
}

function ensureParentDirs(files, filePath) {
  const parts = String(filePath).split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    const parent = cur || '/';
    cur = cur + '/' + parts[i];
    if (!files[cur]) {
      files[cur] = { path: cur, type: 'dir', children: [] };
    }
    if (files[parent] && Array.isArray(files[parent].children)) {
      if (!files[parent].children.includes(parts[i])) {
        files[parent].children.push(parts[i]);
      }
    }
  }
  const parent = filePath.replace(/\/[^/]+$/, '') || '/';
  const name = filePath.split('/').pop();
  if (files[parent] && Array.isArray(files[parent].children)) {
    if (!files[parent].children.includes(name)) {
      files[parent].children.push(name);
    }
  }
}

module.exports = { runInVercelSandbox, collectSandboxFiles };
