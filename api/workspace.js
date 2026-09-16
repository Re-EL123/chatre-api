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
      if (action === 'repo') {
        if (!id) {
          return sendJson(res, 400, { error: 'id required for repo' });
        }
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        let live = null;
        try {
          const RepoMode = require('../lib/repo-mode');
          const files = (await workspace.listFiles(id)) || {};
          const ctx = {
            workspaceId: id,
            files,
            repo: ws.repo || null,
            activeProject: ws.activeProject || null,
            cwd: ws.cwd || '/home/user',
          };
          if (RepoMode.isRepoMode(ctx)) {
            live = RepoMode.repoStatus(ctx);
            if (live && live.ok && ctx.repo) {
              // keep response in sync with live status
            }
          }
        } catch (e) {
          live = { ok: false, error: String((e && e.message) || e) };
        }
        return sendJson(res, 200, {
          repo: (ws && ws.repo) || null,
          branch:
            (live && live.branch) ||
            (ws.repo && ws.repo.branch) ||
            (ws.git && ws.git.branch) ||
            null,
          head: (live && live.head) || (ws.repo && ws.repo.head) || null,
          dirty:
            live && live.dirty != null
              ? live.dirty
              : ws.repo && ws.repo.dirty != null
                ? ws.repo.dirty
                : null,
          lastTest: (ws && ws.lastTest) || null,
          testsOk: !!(ws && ws.testsOk),
          lastDiagnostics: (ws && ws.lastDiagnostics) || null,
          problemCount:
            (ws &&
              ws.lastDiagnostics &&
              Array.isArray(ws.lastDiagnostics.problems) &&
              ws.lastDiagnostics.problems.length) ||
            0,
          runConfigs: (ws && ws.runConfigs) || null,
          status: live,
          revision: (ws && ws.revision) || 0,
        });
      }


      if (action === 'context' || action === 'index') {
        if (!id) {
          return sendJson(res, 400, { error: 'id required for context' });
        }
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const ContextRag = require('../lib/context-rag');
        const ContextCache = require('../lib/context-cache');
        const files = (await workspace.listFiles(id)) || {};
        const rev = Number((ws && ws.revision) || 0);
        let index = ContextCache.getCachedIndex(id, rev, {
          engine: 'chatre-context-v3',
          requireDense: true,
        });
        const force = action === 'index' || url.searchParams.get('rebuild') === '1';
        if (!index || force) {
          index = ContextRag.buildIndex(files, { revision: rev });
          ContextCache.setCachedIndex(id, rev, index);
        }
        if (action === 'index') {
          return sendJson(res, 200, {
            ok: true,
            revision: rev,
            fileCount: index.fileCount,
            chunkCount: index.chunkCount,
            builtAt: index.builtAt,
            merkleRoot: index.merkleRoot || null,
            engine: index.engine || 'chatre-context-v3',
            embed: index.embed || null,
            stack: 'layer2-context',
          });
        }
        const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
        const activeFile = url.searchParams.get('activeFile') || '';
        const openFilesRaw = url.searchParams.get('openFiles') || '';
        const openFiles = openFilesRaw
          ? openFilesRaw.split('|').map((s) => s.trim()).filter(Boolean).slice(0, 16)
          : [];
        const mode = url.searchParams.get('mode') || 'hybrid';
        const pack = ContextRag.packContext({
          files,
          index,
          query: q || activeFile,
          activeFile,
          openFiles,
          mode,
          diagnostics: (ws && ws.lastDiagnostics && ws.lastDiagnostics.problems) || [],
          maxChars: Number(url.searchParams.get('maxChars')) || 12000,
        });
        return sendJson(res, 200, {
          pack: pack.text,
          hits: pack.hits,
          chars: pack.chars,
          mode: pack.mode,
          priorities: pack.priorities || [],
          index: pack.indexMeta,
          revision: rev,
          merkleRoot: index && index.merkleRoot,
          stack: 'layer2-context',
        });
      }


      if (action === 'stack') {
        const SecretStack = require('../lib/secret-stack');
        return sendJson(res, 200, SecretStack.describe());
      }

      if (action === 'worktree') {
        if (!id) {
          return sendJson(res, 400, { error: 'id required for worktree' });
        }
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const Worktree = require('../lib/worktree-sandbox');
        const cwd =
          (ws.repo && ws.repo.root) ||
          ws.cwd ||
          process.cwd();
        const root = Worktree.resolveRepoRoot(cwd);
        if (!root) {
          return sendJson(res, 400, {
            error: 'Not a git repo — worktrees unavailable',
            cwd,
          });
        }
        return sendJson(res, 200, Object.assign({ ok: true, root }, Worktree.listWorktrees(root)));
      }

      if (action === 'diagnostics') {
        if (!id) {
          return sendJson(res, 400, { error: 'id required for diagnostics' });
        }
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const lastDiagnostics = (ws && ws.lastDiagnostics) || null;
        const problems =
          (lastDiagnostics && Array.isArray(lastDiagnostics.problems)
            ? lastDiagnostics.problems
            : []) || [];
        return sendJson(res, 200, {
          problems,
          lastDiagnostics,
          testsOk: !!(ws && ws.testsOk),
          lastTest: (ws && ws.lastTest) || null,
          runConfigs: (ws && ws.runConfigs) || null,
          revision: (ws && ws.revision) || 0,
        });
      }

      if (action === 'export') {
        if (!id) {
          return sendJson(res, 400, { error: 'id required for export' });
        }
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const exported = await workspace.exportWorkspace(id);
        return sendJson(res, 200, exported);
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
          revision: ws.revision || 0,
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
        return sendJson(res, 200, { file, revision: ws.revision || 0 });
      }
      const files = await workspace.listFiles(id);
      return sendJson(res, 200, {
        workspace: ws,
        files,
        revision: ws.revision || 0,
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);

      if ((action === 'context' || action === 'index') && id) {
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const ContextRag = require('../lib/context-rag');
        const ContextCache = require('../lib/context-cache');
        const files = (await workspace.listFiles(id)) || {};
        const rev = Number((ws && ws.revision) || 0);
        let index = ContextCache.getCachedIndex(id, rev, {
          engine: 'chatre-context-v3',
          requireDense: true,
        });
        if (!index || action === 'index' || body.rebuild) {
          index = ContextRag.buildIndex(files, { revision: rev });
          ContextCache.setCachedIndex(id, rev, index);
        }
        if (action === 'index') {
          return sendJson(res, 200, {
            ok: true,
            revision: rev,
            fileCount: index.fileCount,
            chunkCount: index.chunkCount,
            builtAt: index.builtAt,
            merkleRoot: index.merkleRoot || null,
            engine: index.engine || 'chatre-context-v3',
            embed: index.embed || null,
            stack: 'layer2-context',
          });
        }
        const pack = ContextRag.packContext({
          files,
          index,
          query: body.query || body.q || body.activeFile || '',
          activeFile: body.activeFile || '',
          openFiles: Array.isArray(body.openFiles) ? body.openFiles.slice(0, 16) : [],
          selection: body.selection || '',
          cursor: body.cursor || null,
          mode: body.mode || 'hybrid',
          diagnostics:
            body.diagnostics ||
            (ws.lastDiagnostics && ws.lastDiagnostics.problems) ||
            [],
          maxChars: body.maxChars || 12000,
        });
        return sendJson(res, 200, {
          pack: pack.text,
          hits: pack.hits,
          chars: pack.chars,
          mode: pack.mode,
          priorities: pack.priorities || [],
          index: pack.indexMeta,
          revision: rev,
          merkleRoot: index && index.merkleRoot,
          stack: 'layer2-context',
        });
      }

      if (action === 'worktree' && id) {
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        const Worktree = require('../lib/worktree-sandbox');
        const cwd = (ws.repo && ws.repo.root) || ws.cwd || process.cwd();
        const root = Worktree.resolveRepoRoot(cwd);
        if (!root) {
          return sendJson(res, 400, { error: 'Not a git repo — worktrees unavailable' });
        }
        const op = String(body.op || body.action || 'list').toLowerCase();
        if (op === 'create') {
          const created = Worktree.createWorktree(root, {
            id: body.worktreeId || body.name,
            branch: body.branch,
          });
          return sendJson(res, created.ok ? 200 : 400, created);
        }
        if (op === 'remove' || op === 'delete') {
          const removed = Worktree.removeWorktree(root, body.worktreeId || body.path || body.name);
          return sendJson(res, removed.ok ? 200 : 400, removed);
        }
        return sendJson(res, 200, Object.assign({ ok: true, root }, Worktree.listWorktrees(root)));
      }

      if (action === 'file' && id) {
        const ws = await workspace.getWorkspace(id);
        const gate = assertWs(ws, auth);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        if (!body.path) return sendJson(res, 400, { error: 'path required' });
        const prev = await workspace.getFile(id, body.path);
        let file;
        try {
          file = await workspace.putFile(
            id,
            {
              path: body.path,
              type: body.type || 'file',
              content: body.content != null ? body.content : '',
              children: body.children || [],
              encoding: body.encoding || 'utf8',
            },
            {
              allowEmpty: !!body.allowEmpty || !!body.overwrite_empty,
              overwrite_empty: !!body.overwrite_empty,
            },
          );
        } catch (e) {
          if (e && e.code === 'EMPTY_WRITE_BLOCKED') {
            return sendJson(res, 409, { error: e.message, code: e.code });
          }
          throw e;
        }
        const bumped = await workspace.bumpRevision(id, {
          expectedRevision:
            body.expectedRevision != null ? body.expectedRevision : undefined,
        }).catch(async (e) => {
          if (e && e.code === 'REVISION_CONFLICT') {
            return workspace.bumpRevision(id, {});
          }
          throw e;
        });
        try {
          require('../lib/context-cache').clearCachedIndex(id);
        } catch (e) {}
        return sendJson(res, 200, {
          file,
          previous:
            file._previousContent != null
              ? file._previousContent
              : prev && prev.type === 'file'
                ? prev.content
                : null,
          revision: bumped.revision,
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
          revision: ws.revision || 0,
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
        const snap = await workspace.saveSnapshot(id, {
          cwd: root,
          projects,
          activeProject: slug,
          expectedRevision:
            body.expectedRevision != null ? body.expectedRevision : undefined,
        });
        const updated = await workspace.getWorkspace(id);
        return sendJson(res, 200, {
          workspace: updated,
          activeProject: slug,
          root,
          revision: snap.revision,
        });
      }
      const ws = await workspace.createWorkspace({
        name: body.name,
        userId: auth.uid,
      });
      const files = await workspace.listFiles(ws.id);
      return sendJson(res, 201, { workspace: ws, files, revision: 0 });
    }

    if (req.method === 'DELETE') {
      if (!id || !filePath) {
        return sendJson(res, 400, { error: 'id and path required' });
      }
      const ws = await workspace.getWorkspace(id);
      const gate = assertWs(ws, auth);
      if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
      const files = (await workspace.listFiles(id)) || {};
      const result = await workspace.deleteFileTree(id, files, filePath, {
        cwd: ws.cwd,
        git: ws.git,
        projects: ws.projects,
        activeProject: ws.activeProject,
      });
      return sendJson(res, 200, {
        ok: true,
        deleted: result.deleted,
        revision: result.revision,
      });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    if (err && err.code === 'REVISION_CONFLICT') {
      return sendJson(res, 409, {
        error: err.message || 'revision conflict',
        code: 'REVISION_CONFLICT',
        revision: err.revision,
      });
    }
    if (err && err.code === 'EMPTY_WRITE_BLOCKED') {
      return sendJson(res, 409, {
        error: err.message,
        code: 'EMPTY_WRITE_BLOCKED',
      });
    }
    return sendJson(res, 500, { error: err.message || 'workspace failed' });
  }
};
