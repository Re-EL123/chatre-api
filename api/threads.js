'use strict';

const { handleCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const threads = require('../lib/threads');
const { ensureWorkspace } = require('../lib/workspace');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!requireAuth(req, res)) return;

  try {
    const url = new URL(req.url, 'http://localhost');
    const threadId = url.searchParams.get('id');
    const action = url.searchParams.get('action') || '';

    if (req.method === 'GET') {
      if (threadId && action === 'messages') {
        const list = await threads.listMessages(threadId);
        return sendJson(res, 200, { messages: list });
      }
      if (threadId) {
        const thr = await threads.getThread(threadId);
        if (!thr) return sendJson(res, 404, { error: 'Thread not found' });
        return sendJson(res, 200, { thread: thr });
      }
      const list = await threads.listThreads();
      return sendJson(res, 200, { threads: list });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (threadId && action === 'messages') {
        const msg = await threads.appendMessage(threadId, {
          role: body.role || 'user',
          content: body.content || '',
          meta: body.meta || null,
        });
        return sendJson(res, 201, { message: msg });
      }
      const ws = await ensureWorkspace(body.workspaceId);
      const thr = await threads.createThread({
        title: body.title,
        model: body.model,
        workspaceId: ws.id,
      });
      return sendJson(res, 201, { thread: thr, workspace: ws });
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      if (!threadId) return sendJson(res, 400, { error: 'id required' });
      const body = await readBody(req);
      const thr = await threads.updateThread(threadId, body);
      if (!thr) return sendJson(res, 404, { error: 'Thread not found' });
      return sendJson(res, 200, { thread: thr });
    }

    if (req.method === 'DELETE') {
      if (!threadId) return sendJson(res, 400, { error: 'id required' });
      await threads.deleteThread(threadId);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message || 'threads failed' });
  }
};
