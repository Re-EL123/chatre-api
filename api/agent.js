'use strict';

const { handleCors, applyCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const threads = require('../lib/threads');
const workspace = require('../lib/workspace');
const { runAgentLoop } = require('../lib/agent');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.kind !== 'user') {
    return sendJson(res, 403, { error: 'Sign in required to run the agent' });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const wantResume = body.resume === true || body.approvePlan === true;
  const message = String(body.message || body.prompt || '').trim();
  if (!message && !wantResume) {
    return sendJson(res, 400, { error: 'message required (or resume:true)' });
  }

  try {
    let thr = body.threadId ? await threads.getThread(body.threadId) : null;
    let ws = null;

    function denyThread() {
      return sendJson(res, 403, { error: 'Thread access denied' });
    }
    if (thr && thr.userId && thr.userId !== auth.uid) return denyThread();
    if (thr && !thr.userId) {
      return sendJson(res, 404, { error: 'Thread not found' });
    }

    if (wantResume) {
      if (!thr) {
        return sendJson(res, 400, { error: 'threadId required to resume' });
      }
      const st = thr.agentRun && thr.agentRun.status;
      if (st !== 'interrupted' && st !== 'awaiting_plan' && st !== 'awaiting_login') {
        return sendJson(res, 409, {
          error:
            'No interrupted/awaiting_plan/awaiting_login agent run to resume on this thread',
          agentRun: thr.agentRun || null,
        });
      }
      ws = await workspace.ensureWorkspace(thr.workspaceId || body.workspaceId, {
        userId: auth.uid,
      });
    } else if (!thr) {
      ws = await workspace.ensureWorkspace(body.workspaceId, { userId: auth.uid });
      thr = await threads.createThread({
        title: message.slice(0, 80),
        model: body.model || '',
        provider: body.provider || '',
        workspaceId: ws.id,
        userId: auth.uid,
      });
    } else {
      ws = await workspace.ensureWorkspace(thr.workspaceId || body.workspaceId, {
        userId: auth.uid,
      });
      if (!thr.workspaceId) {
        thr = await threads.updateThread(thr.id, { workspaceId: ws.id });
      }
      if (body.model) {
        thr = await threads.updateThread(thr.id, {
          model: body.model,
          provider: body.provider || thr.provider,
        });
      }
    }

    const history = await threads.listMessages(thr.id);
    const wantStream = body.stream !== false;

    const runOpts = {
      threadId: thr.id,
      workspaceId: ws.id,
      userMessage: wantResume && !message ? '' : message,
      history,
      model: body.model || thr.model,
      userId: auth.uid,
      maxIterations: body.maxIterations || 25,
      resume: wantResume,
      budgetMs: body.budgetMs,
      approvePlan: body.approvePlan === true,
      briefingOverride: body.briefing || null,
      skipPlanApproval: body.skipPlanApproval === true || body.approvePlan === true,
    };

    if (!wantStream) {
      const events = [];
      const result = await runAgentLoop({
        ...runOpts,
        emit: (ev) => events.push(ev),
      });
      return sendJson(res, 200, {
        threadId: thr.id,
        workspaceId: ws.id,
        response: result.response,
        steps: result.steps,
        status: result.status || 'done',
        runId: result.runId,
        usage: result.usage,
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
      resume: wantResume,
    });

    await runAgentLoop({
      ...runOpts,
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
