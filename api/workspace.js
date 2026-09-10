'use strict';

const { handleCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const workspace = require('../lib/workspace');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!requireAuth(req, res)) return;

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
        if (!ws) return sendJson(res, 404, { error: 'Workspace not found' });
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

      if (!id) {
        return sendJson(res, 400, {
          error: 'id required — pass workspace id from the active thread',
        });
      }
      const ws = await workspace.getWorkspace(id);
      if (!ws) return sendJson(res, 404, { error: 'Workspace not found' });
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
          previous: prev && prev.type === 'file' ? prev.content : null,
        });
      }
      if (action === 'diff' && id) {
        const file = await workspace.getFile(id, body.path);
        if (!file) return sendJson(res, 404, { error: 'File not found' });
        return sendJson(res, 200, {
          path: body.path,
          current: file.content || '',
          previous: body.previous != null ? body.previous : null,
        });
      }
      const ws = await workspace.createWorkspace({ name: body.name });
      const files = await workspace.listFiles(ws.id);
      return sendJson(res, 201, { workspace: ws, files });
    }

    if (req.method === 'DELETE') {
      if (!id || !filePath) {
        return sendJson(res, 400, { error: 'id and path required' });
      }
      await workspace.deleteFile(id, filePath);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message || 'workspace failed' });
  }
};
