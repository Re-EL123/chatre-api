'use strict';

const { handleCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const threads = require('../lib/threads');
const { ensureWorkspace } = require('../lib/workspace');

function assertThreadAccess(thr, auth) {
  if (!thr) return { ok: false, status: 404, error: 'Thread not found' };
  if (auth.kind === 'service') {
    return { ok: false, status: 403, error: 'Admin service token cannot access user threads (RBAC)' };
  }
  if (thr.userId && thr.userId !== auth.uid) {
    return { ok: false, status: 403, error: 'Thread access denied' };
  }
  // Legacy threads without userId: hide from user UI
  if (!thr.userId) {
    return { ok: false, status: 404, error: 'Thread not found' };
  }
  return { ok: true };
}

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (auth.kind === 'service') {
    return sendJson(res, 403, {
      error:
        'Admin service token cannot list or mutate user threads — sign in as a user (RBAC)',
    });
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const threadId = url.searchParams.get('id');
    const action = url.searchParams.get('action') || '';

    if (req.method === 'GET') {
      if (threadId && action === 'messages') {
        const thr = await threads.getThread(threadId);
        const gate = assertThreadAccess(thr, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const list = await threads.listMessages(threadId);
        return sendJson(res, 200, { messages: list });
      }
      if (threadId) {
        const thr = await threads.getThread(threadId);
        const gate = assertThreadAccess(thr, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        return sendJson(res, 200, { thread: thr });
      }
      const list = await threads.listThreads(50, { userId: auth.uid });
      return sendJson(res, 200, { threads: list });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (threadId && action === 'messages') {
        const thr = await threads.getThread(threadId);
        const gate = assertThreadAccess(thr, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const msg = await threads.appendMessage(threadId, {
          role: body.role || 'user',
          content: body.content || '',
          meta: body.meta || null,
        });
        return sendJson(res, 201, { message: msg });
      }
      const ws = await ensureWorkspace(body.workspaceId, { userId: auth.uid });
      const thr = await threads.createThread({
        title: body.title,
        model: body.model,
        provider: body.provider,
        workspaceId: ws.id,
        userId: auth.uid,
      });
      return sendJson(res, 201, { thread: thr, workspace: ws });
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      if (!threadId) return sendJson(res, 400, { error: 'id required' });
      const thr0 = await threads.getThread(threadId);
      const gate = assertThreadAccess(thr0, auth);
      if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
      const body = await readBody(req);
      const thr = await threads.updateThread(threadId, body);
      if (!thr) return sendJson(res, 404, { error: 'Thread not found' });
      return sendJson(res, 200, { thread: thr });
    }

    if (req.method === 'DELETE') {
      if (!threadId) return sendJson(res, 400, { error: 'id required' });
      const thr0 = await threads.getThread(threadId);
      const gate = assertThreadAccess(thr0, auth);
      if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
      await threads.deleteThread(threadId);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message || 'threads failed' });
  }
};
