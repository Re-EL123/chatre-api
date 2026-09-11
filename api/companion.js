'use strict';

const { handleCors, applyCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const companion = require('../lib/companion');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  applyCors(res);
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    const id = req.query && (req.query.id || req.query.companionId);
    const st = await companion.status(id);
    return sendJson(res, 200, st);
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

  const op = String(body.op || body.action || '').toLowerCase();
  const companionId = body.companionId || body.id;

  try {
    if (op === 'heartbeat') {
      const out = await companion.heartbeat(companionId, body.caps);
      return sendJson(res, 200, out);
    }
    if (op === 'poll') {
      await companion.heartbeat(companionId, body.caps);
      const waitMs = Math.min(Math.max(Number(body.waitMs) || 0, 0), 20000);
      const started = Date.now();
      let jobs = await companion.claimPending(companionId, body.limit);
      while (!jobs.length && Date.now() - started < waitMs) {
        await new Promise((r) => setTimeout(r, 500));
        jobs = await companion.claimPending(companionId, body.limit);
      }
      return sendJson(res, 200, { ok: true, jobs });
    }
    if (op === 'result') {
      const out = await companion.completeJob(body.jobId, body.result);
      return sendJson(res, 200, out);
    }
    if (op === 'enqueue') {
      const job = await companion.enqueueJob({
        companionId,
        action: body.desktopAction || body.jobAction,
        params: body.params,
        tool: body.tool,
      });
      return sendJson(res, 200, { ok: true, job });
    }
    if (op === 'status') {
      return sendJson(res, 200, await companion.status(companionId));
    }
    return sendJson(res, 400, {
      error: 'Unknown op (heartbeat|poll|result|enqueue|status)',
    });
  } catch (err) {
    return sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
