'use strict';

const { handleCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const workspace = require('../lib/workspace');
const { unifiedDiff } = require('../lib/diff');

function assertWs(ws, auth) {
  if (!ws) return { ok: false, status: 404, error: 'Workspace not found' };
  if (auth.kind === 'service') {
    return { ok: false, status: 403, error: 'Service token cannot access user workspaces' };
  }
  if (ws.userId && ws.userId !== auth.uid) {
    return { ok: false, status: 403, error: 'Workspace access denied' };
  }
  if (!ws.userId) {
    return { ok: false, status: 404, error: 'Workspace not found' };
  }
  return { ok: true };
}

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.kind !== 'user') {
    return sendJson(res, 403, { error: 'Sign in required for workspaces' });
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const filePath = url.searchParams.get('path');
    const action = url.searchParams.get('action') || '';

    if (req.method === 'GET') {
      if (action === 'export') {
        if (!id) {
          return sendJson(res, 400, { error: 'id required for export' });
        }
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const files = (await workspace.listFiles(id)) || {};
        const exportFiles = {};
        Object.values(files).forEach((f) => {
          if (f && f.type === 'file' && f.path) {
            exportFiles[f.path] = f.content || '';
          }
        });
        return sendJson(res, 200, {
          workspace: ws,
          files: exportFiles,
          fileCount: Object.keys(exportFiles).length,
          exportedAt: new Date().toISOString(),
        });
      }

      if (action === 'diff') {
        if (!id || !filePath) {
          return sendJson(res, 400, { error: 'id and path required' });
        }
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const file = await workspace.getFile(id, filePath);
        if (!file) return sendJson(res, 404, { error: 'File not found' });
        const previous =
          file.previousContent != null ? file.previousContent : '';
        const current = file.content || '';
        return sendJson(res, 200, {
          path: filePath,
          previous,
          current,
          unified: unifiedDiff(previous, current, filePath),
          updatedAt: file.updatedAt || null,
        });
      }

      if (!id) {
        return sendJson(res, 400, {
          error: 'id required — pass workspace id from the active thread',
        });
      }
      const ws = await workspace.getWorkspace(id);
      const gate = assertWs(ws, auth);
      if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
      if (filePath) {
        const file = await workspace.getFile(id, filePath);
        if (!file) return sendJson(res, 404, { error: 'File not found' });
        return sendJson(res, 200, { file });
      }
      const files = await workspace.listFiles(id);
      return sendJson(res, 200, { workspace: ws, files });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (action === 'file' && id) {
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        if (!body.path) return sendJson(res, 400, { error: 'path required' });
        const prev = await workspace.getFile(id, body.path);
        const file = await workspace.putFile(id, {
          path: body.path,
          type: body.type || 'file',
          content: body.content || '',
          children: body.children || [],
        });
        return sendJson(res, 200, {
          file,
          previous:
            file._previousContent != null
              ? file._previousContent
              : prev && prev.type === 'file'
                ? prev.content
                : null,
        });
      }
      if (action === 'diff' && id) {
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const file = await workspace.getFile(id, body.path);
        if (!file) return sendJson(res, 404, { error: 'File not found' });
        const previous =
          body.previous != null
            ? body.previous
            : file.previousContent != null
              ? file.previousContent
              : '';
        const current = file.content || '';
        return sendJson(res, 200, {
          path: body.path,
          current,
          previous,
          unified: unifiedDiff(previous, current, body.path),
        });
      }
      if (action === 'activeProject' && id) {
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const slug = String(body.slug || body.activeProject || '')
          .replace(/[^a-z0-9._-]/gi, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 48);
        if (!slug) {
          return sendJson(res, 400, { error: 'slug required' });
        }
        const root = '/home/user/projects/' + slug;
        const files = (await workspace.listFiles(id)) || {};
        const projects = Object.assign({}, ws.projects || {}, {
          [slug]: Object.assign({}, (ws.projects && ws.projects[slug]) || {}, {
            slug,
            root,
            agentsMd: root + '/AGENTS.md',
            hasAgentsMd: !!(
              files[root + '/AGENTS.md'] &&
              files[root + '/AGENTS.md'].type === 'file'
            ),
            lastActiveAt: new Date().toISOString(),
          }),
        });
        await workspace.saveSnapshot(id, {
          cwd: root,
          projects,
          activeProject: slug,
        });
        const updated = await workspace.getWorkspace(id);
        return sendJson(res, 200, {
          workspace: updated,
          activeProject: slug,
          root,
        });
      }
      const ws = await workspace.createWorkspace({
        name: body.name,
        userId: auth.uid,
      });
      const files = await workspace.listFiles(ws.id);
      return sendJson(res, 201, { workspace: ws, files });
    }

    if (req.method === 'DELETE') {
      if (!id || !filePath) {
        return sendJson(res, 400, { error: 'id and path required' });
      }
      const ws = await workspace.getWorkspace(id);
      const gate = assertWs(ws, auth);
      if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
      await workspace.deleteFile(id, filePath);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message || 'workspace failed' });
  }
};
