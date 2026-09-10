'use strict';

const { handleCors, applyCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const threads = require('../lib/threads');
const workspace = require('../lib/workspace');
const { runAgentLoop } = require('../lib/agent');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const message = String(body.message || body.prompt || '').trim();
  if (!message) return sendJson(res, 400, { error: 'message required' });

  try {
    let thr = body.threadId ? await threads.getThread(body.threadId) : null;
    let ws = null;
    if (!thr) {
      ws = await workspace.ensureWorkspace(body.workspaceId);
      thr = await threads.createThread({
        title: message.slice(0, 80),
        model: body.model || '',
        workspaceId: ws.id,
      });
    } else {
      ws = await workspace.ensureWorkspace(thr.workspaceId || body.workspaceId);
      if (!thr.workspaceId) {
        thr = await threads.updateThread(thr.id, { workspaceId: ws.id });
      }
    }

    const history = await threads.listMessages(thr.id);
    const wantStream = body.stream !== false;

    if (!wantStream) {
      const events = [];
      const result = await runAgentLoop({
        threadId: thr.id,
        workspaceId: ws.id,
        userMessage: message,
        history,
        model: body.model,
        maxIterations: body.maxIterations || 20,
        emit: (ev) => events.push(ev),
      });
      return sendJson(res, 200, {
        threadId: thr.id,
        workspaceId: ws.id,
        response: result.response,
        steps: result.steps,
        events,
      });
    }

    applyCors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (ev) => {
      res.write('data: ' + JSON.stringify(ev) + '\n\n');
    };

    send({
      type: 'start',
      threadId: thr.id,
      workspaceId: ws.id,
    });

    await runAgentLoop({
      threadId: thr.id,
      workspaceId: ws.id,
      userMessage: message,
      history,
      model: body.model,
      maxIterations: body.maxIterations || 20,
      emit: send,
    });

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(err);
    if (res.headersSent) {
      res.write(
        'data: ' +
          JSON.stringify({ type: 'error', error: err.message || String(err) }) +
          '\n\n',
      );
      res.end();
      return;
    }
    return sendJson(res, 500, { error: err.message || 'agent failed' });
  }
};
