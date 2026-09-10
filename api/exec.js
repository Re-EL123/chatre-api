'use strict';

const { handleCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const workspace = require('../lib/workspace');
const { runInTempWorkspace } = require('../lib/shell');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readBody(req);
    const cmd = body.cmd || body.command;
    if (!cmd) return sendJson(res, 400, { error: 'cmd required' });

    let ws = body.workspaceId
      ? await workspace.getWorkspace(body.workspaceId)
      : null;
    if (!ws) ws = await workspace.ensureWorkspace(body.workspaceId);

    const files = (await workspace.listFiles(ws.id)) || {};
    const result = runInTempWorkspace({
      files,
      cwd: body.cwd || ws.cwd || '/home/user',
      command: cmd,
      timeoutMs: body.timeoutMs || 25000,
    });

    await workspace.saveSnapshot(ws.id, {
      files: result.files,
      cwd: result.cwd,
      git: ws.git,
    });

    return sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      code: result.code,
      output: result.output,
      error: result.error,
      cwd: result.cwd,
      workspaceId: ws.id,
    });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message || 'exec failed' });
  }
};
