'use strict';

/**
 * Optional Vercel Sandbox execution.
 * Enabled when USE_VERCEL_SANDBOX=1 and @vercel/sandbox is installed.
 */

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
    // Materialize files
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
        // write via printf/base64 for safety
        const b64 = Buffer.from(entry.content || '', 'utf8').toString('base64');
        await sandbox.runCommand('sh', [
          '-c',
          'echo ' + JSON.stringify(b64) + ' | base64 -d > ' + JSON.stringify(rel),
        ]);
      }
    }

    const work = String(cwd || '/home/user').replace(/^\//, '') || '.';
    await sandbox.runCommand('mkdir', ['-p', work]);
    const result = await sandbox.runCommand('sh', ['-lc', 'cd ' + work + ' && ' + command]);
    const stdout = await result.stdout();
    const stderr = await result.stderr();
    const output = String(stdout || '') + String(stderr || '');

    return {
      ok: result.exitCode === 0,
      code: result.exitCode,
      output: output.slice(0, 100000),
      error: result.exitCode === 0 ? null : 'exit ' + result.exitCode,
      sandbox: true,
      // Caller keeps existing files unless we re-collect (expensive); return null files to mean "unchanged"
      files: null,
      cwd,
    };
  } finally {
    try {
      await sandbox.stop();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { runInVercelSandbox };
