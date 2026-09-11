'use strict';

const { handleCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const workspace = require('../lib/workspace');
const {
  runInTempWorkspace,
  runWorkspaceCommand,
  resolveMode,
} = require('../lib/shell');
const { runInVercelSandbox } = require('../lib/sandbox');

function writeSse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.kind !== 'user') {
    return sendJson(res, 403, { error: 'Sign in required' });
  }
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
    if (ws && ws.userId && ws.userId !== auth.uid) {
      return sendJson(res, 403, { error: 'Workspace access denied' });
    }
    if (!ws) ws = await workspace.ensureWorkspace(body.workspaceId, { userId: auth.uid });

    const files = (await workspace.listFiles(ws.id)) || {};
    const cwd = body.cwd || ws.cwd || '/home/user';
    const mode = resolveMode(body.mode);
    const stream = body.stream === true || body.stream === 1;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      writeSse(res, {
        type: 'shell_start',
        command: cmd,
        cwd,
        mode,
        workspaceId: ws.id,
      });

      let result;
      if (mode === 'sandbox') {
        result = await runInVercelSandbox({
          files,
          cwd,
          command: cmd,
          timeoutMs: body.timeoutMs || 90000,
        });
        if (result && result.output) {
          writeSse(res, {
            type: 'shell_chunk',
            stream: 'stdout',
            chunk: result.output,
          });
        }
      } else {
        result = await runWorkspaceCommand({
          files,
          cwd,
          command: cmd,
          timeoutMs: body.timeoutMs || 25000,
          workspaceId: ws.id,
          onChunk: (ev) => {
            writeSse(res, {
              type: 'shell_chunk',
              stream: ev.stream,
              chunk: ev.chunk,
              needs_input: !!ev.needsInput,
            });
          },
        });
      }

      if (result && result.files) {
        await workspace.saveSnapshot(ws.id, {
          files: result.files,
          cwd: result.cwd,
          git: ws.git,
        });
      }

      writeSse(res, {
        type: 'shell_done',
        ok: !!(result && result.ok),
        code: result && result.code,
        output: result && result.output,
        error: result && result.error,
        cwd: (result && result.cwd) || cwd,
        durationMs: result && result.durationMs,
        truncated: !!(result && result.truncated),
        needs_input: !!(result && result.needs_input),
        mode: (result && result.mode) || mode,
        workspaceId: ws.id,
      });
      res.end();
      return;
    }

    let result;
    if (mode === 'sandbox') {
      result = await runInVercelSandbox({
        files,
        cwd,
        command: cmd,
        timeoutMs: body.timeoutMs || 90000,
      });
      if (!result || result.skipped) {
        result = await runWorkspaceCommand({
          files,
          cwd,
          command: cmd,
          timeoutMs: body.timeoutMs || 25000,
          workspaceId: ws.id,
        });
      }
    } else {
      result = await runWorkspaceCommand({
        files,
        cwd,
        command: cmd,
        timeoutMs: body.timeoutMs || 25000,
        workspaceId: ws.id,
      });
    }

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
      durationMs: result.durationMs,
      truncated: !!result.truncated,
      needs_input: !!result.needs_input,
      mode: result.mode || mode,
      workspaceId: ws.id,
    });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message || 'exec failed' });
  }
};

// keep sync helper available for tests
void runInTempWorkspace;
