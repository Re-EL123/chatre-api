'use strict';

const {
  getBackend,
  siteRef,
  encodePath,
  decodePath,
  nowIso,
  memory,
} = require('./firebase');
const { newId } = require('./http');
const Sync = require('./workspace-sync');

function defaultFiles() {
  return {
    '/': { path: '/', type: 'dir', children: ['home', 'tmp', 'etc'] },
    '/home': { path: '/home', type: 'dir', children: ['user'] },
    '/home/user': {
      path: '/home/user',
      type: 'dir',
      children: ['documents', 'projects', 'readme.txt'],
    },
    '/home/user/documents': { path: '/home/user/documents', type: 'dir', children: [] },
    '/home/user/projects': { path: '/home/user/projects', type: 'dir', children: [] },
    '/home/user/readme.txt': {
      path: '/home/user/readme.txt',
      type: 'file',
      content:
        'Welcome to the Chatre remote workspace.\nFiles persist in Firestore and sync across sessions.\n',
      encoding: 'utf8',
    },
    '/tmp': { path: '/tmp', type: 'dir', children: [] },
    '/etc': { path: '/etc', type: 'dir', children: [] },
  };
}

function defaultGit() {
  return {
    initialized: false,
    branch: 'main',
    staged: [],
    commits: [],
    remotes: {},
  };
}

async function createWorkspace({ name, userId } = {}) {
  const id = newId('ws');
  const meta = {
    id,
    name: name || 'default',
    userId: userId || null,
    cwd: '/home/user',
    git: defaultGit(),
    projects: {},
    activeProject: null,
    revision: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const files = defaultFiles();
  if (getBackend() === 'firestore') {
    await siteRef().collection('workspaces').doc(id).set(meta);
    const entries = Object.values(files);
    const firebaseAdmin = require('./firebase').admin();
    for (let i = 0; i < entries.length; i += 40) {
      const chunk = entries.slice(i, i + 40);
      const b = firebaseAdmin.firestore().batch();
      for (const f of chunk) {
        const ref = siteRef()
          .collection('workspaces')
          .doc(id)
          .collection('files')
          .doc(encodePath(f.path));
        b.set(ref, f);
      }
      await b.commit();
    }
  } else {
    memory.workspaces.set(id, {
      meta,
      files: new Map(Object.entries(files)),
    });
  }
  return meta;
}

async function getWorkspace(workspaceId) {
  if (getBackend() === 'firestore') {
    const doc = await siteRef().collection('workspaces').doc(workspaceId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }
  const ws = memory.workspaces.get(workspaceId);
  return ws ? ws.meta : null;
}

async function listFiles(workspaceId) {
  if (getBackend() === 'firestore') {
    const snap = await siteRef()
      .collection('workspaces')
      .doc(workspaceId)
      .collection('files')
      .get();
    const out = {};
    snap.docs.forEach((d) => {
      const data = d.data();
      out[data.path] = data;
    });
    return out;
  }
  const ws = memory.workspaces.get(workspaceId);
  if (!ws) return null;
  const out = {};
  ws.files.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

async function getFile(workspaceId, filePath) {
  if (getBackend() === 'firestore') {
    const doc = await siteRef()
      .collection('workspaces')
      .doc(workspaceId)
      .collection('files')
      .doc(encodePath(filePath))
      .get();
    if (!doc.exists) return null;
    return doc.data();
  }
  const ws = memory.workspaces.get(workspaceId);
  return ws ? ws.files.get(filePath) || null : null;
}

async function putFile(workspaceId, file, opts) {
  const o = opts || {};
  const path = file.path;
  let previousContent = null;
  const existing = await getFile(workspaceId, path);

  if (file.type === 'file' || (!file.type && file.content != null)) {
    const block = Sync.emptyWriteBlocked(existing, file.content, o);
    if (block) {
      const err = new Error(block.error);
      err.code = 'EMPTY_WRITE_BLOCKED';
      throw err;
    }
  }

  if (getBackend() === 'firestore') {
    if (existing && existing.type === 'file' && existing.content != null) {
      previousContent = existing.content;
    }
    const payload = {
      ...file,
      path,
      updatedAt: nowIso(),
      hash: Sync.contentHash(file),
    };
    if (file.type === 'file' || (!file.type && file.content != null)) {
      payload.type = 'file';
      if (previousContent != null && previousContent !== String(file.content || '')) {
        payload.previousContent = previousContent;
      } else if (existing && existing.previousContent != null && previousContent == null) {
        payload.previousContent = existing.previousContent;
      }
    }
    await siteRef()
      .collection('workspaces')
      .doc(workspaceId)
      .collection('files')
      .doc(encodePath(path))
      .set(payload, { merge: true });
    return { ...payload, _previousContent: previousContent };
  }
  const ws = memory.workspaces.get(workspaceId);
  if (!ws) throw new Error('Workspace not found');
  if (existing && existing.type === 'file' && existing.content != null) {
    previousContent = existing.content;
  }
  const next = { ...file, path, hash: Sync.contentHash(file) };
  if (next.type === 'file' || next.content != null) {
    next.type = 'file';
    if (previousContent != null && previousContent !== String(file.content || '')) {
      next.previousContent = previousContent;
    }
  }
  ws.files.set(path, next);
  ws.meta.updatedAt = nowIso();
  return { ...next, _previousContent: previousContent };
}

async function deleteFile(workspaceId, filePath) {
  if (getBackend() === 'firestore') {
    await siteRef()
      .collection('workspaces')
      .doc(workspaceId)
      .collection('files')
      .doc(encodePath(filePath))
      .delete();
  } else {
    const ws = memory.workspaces.get(workspaceId);
    if (ws) ws.files.delete(filePath);
  }
  return true;
}

/**
 * Delete a path and all descendants; fix parent children; bump revision.
 */
async function deleteFileTree(workspaceId, filesMap, targetPath, opts) {
  const o = opts || {};
  const files = filesMap || (await listFiles(workspaceId)) || {};
  const { deleted } = Sync.removePathFromTree(files, targetPath);
  // Also remove from store even if not in map
  const toDelete = new Set(deleted);
  toDelete.add(String(targetPath));
  // Find descendants still in store
  const all = await listFiles(workspaceId);
  if (all) {
    const prefix = String(targetPath).endsWith('/')
      ? String(targetPath)
      : String(targetPath) + '/';
    Object.keys(all).forEach((p) => {
      if (p === targetPath || p.indexOf(prefix) === 0) toDelete.add(p);
    });
  }
  for (const p of toDelete) {
    await deleteFile(workspaceId, p);
  }
  const parent = String(targetPath).replace(/\/[^/]+$/, '') || '/';
  if (files[parent] && files[parent].type === 'dir') {
    await putFile(workspaceId, files[parent], { allowEmpty: true });
  }
  const bumped = await bumpRevision(workspaceId, {
    expectedRevision: o.expectedRevision,
    cwd: o.cwd,
    git: o.git,
    projects: o.projects,
    activeProject: o.activeProject,
  });
  return {
    deleted: Array.from(toDelete),
    revision: bumped.revision,
    files,
  };
}

async function bumpRevision(workspaceId, opts) {
  const o = opts || {};
  const meta = await getWorkspace(workspaceId);
  if (!meta) throw new Error('Workspace not found');
  if (
    o.expectedRevision != null &&
    Number(meta.revision || 0) !== Number(o.expectedRevision)
  ) {
    const err = new Error(
      'Workspace revision conflict (expected ' +
        o.expectedRevision +
        ', got ' +
        (meta.revision || 0) +
        ')',
    );
    err.code = 'REVISION_CONFLICT';
    err.revision = meta.revision || 0;
    throw err;
  }
  const nextRev = Number(meta.revision || 0) + 1;
  const patch = { updatedAt: nowIso(), revision: nextRev };
  if (o.cwd) patch.cwd = o.cwd;
  if (o.git) patch.git = o.git;
  if (o.projects) patch.projects = o.projects;
  if (o.activeProject !== undefined) patch.activeProject = o.activeProject;
  if (o.repo !== undefined) patch.repo = o.repo;
  if (o.lastTest !== undefined) patch.lastTest = o.lastTest;
  if (o.testsOk !== undefined) patch.testsOk = o.testsOk;
  if (o.lastDiagnostics !== undefined) patch.lastDiagnostics = o.lastDiagnostics;
  if (o.runConfigs !== undefined) patch.runConfigs = o.runConfigs;
  if (getBackend() === 'firestore') {
    await siteRef().collection('workspaces').doc(workspaceId).set(patch, { merge: true });
  } else {
    const ws = memory.workspaces.get(workspaceId);
    if (ws) Object.assign(ws.meta, patch);
  }
  return { revision: nextRev, workspace: await getWorkspace(workspaceId) };
}

/**
 * Solid snapshot:
 * - optional CAS via expectedRevision
 * - incremental puts (hash compare)
 * - prune store paths missing from files map
 */
async function saveSnapshot(workspaceId, opts) {
  const o = opts || {};
  const {
    files,
    cwd,
    git,
    projects,
    activeProject,
    repo,
    lastTest,
    testsOk,
    lastDiagnostics,
    runConfigs,
    expectedRevision,
    prune = false,
    incremental = true,
    baseFiles,
  } = o;

  const meta = await getWorkspace(workspaceId);
  if (!meta) throw new Error('Workspace not found');
  if (
    expectedRevision != null &&
    Number(meta.revision || 0) !== Number(expectedRevision)
  ) {
    const err = new Error(
      'Workspace revision conflict (expected ' +
        expectedRevision +
        ', got ' +
        (meta.revision || 0) +
        ')',
    );
    err.code = 'REVISION_CONFLICT';
    err.revision = meta.revision || 0;
    throw err;
  }

  const existing =
    incremental || prune
      ? baseFiles || (await listFiles(workspaceId)) || {}
      : {};
  const changed = [];
  const deleted = [];

  if (files) {
    const entries = Object.entries(files);
    for (let i = 0; i < entries.length; i++) {
      const [p, f] = entries[i];
      if (!f || !p) continue;
      if (incremental && !Sync.fileChanged(existing[p], f)) continue;
      try {
        await putFile(workspaceId, f, { allowEmpty: true });
        changed.push(p);
      } catch (e) {
        if (e && e.code === 'EMPTY_WRITE_BLOCKED') continue;
        throw e;
      }
    }
    if (prune) {
      const keep = new Set(Object.keys(files));
      Object.keys(existing).forEach((p) => {
        if (!keep.has(p) && Sync.shouldPrunePath(p)) deleted.push(p);
      });
      // Batch deletes
      for (let i = 0; i < deleted.length; i++) {
        await deleteFile(workspaceId, deleted[i]);
      }
    }
  }

  const nextRev = Number(meta.revision || 0) + 1;
  const patch = { updatedAt: nowIso(), revision: nextRev };
  if (cwd) patch.cwd = cwd;
  if (git) patch.git = git;
  if (projects) patch.projects = projects;
  if (activeProject !== undefined) patch.activeProject = activeProject;
  if (repo !== undefined) patch.repo = repo;
  if (lastTest !== undefined) patch.lastTest = lastTest;
  if (testsOk !== undefined) patch.testsOk = testsOk;
  if (lastDiagnostics !== undefined) patch.lastDiagnostics = lastDiagnostics;
  if (runConfigs !== undefined) patch.runConfigs = runConfigs;

  if (getBackend() === 'firestore') {
    await siteRef().collection('workspaces').doc(workspaceId).set(patch, { merge: true });
  } else {
    const ws = memory.workspaces.get(workspaceId);
    if (ws) Object.assign(ws.meta, patch);
  }

  const workspace = await getWorkspace(workspaceId);
  return {
    workspace,
    revision: nextRev,
    changed,
    deleted,
  };
}

async function ensureWorkspace(workspaceId, { userId } = {}) {
  if (workspaceId) {
    const existing = await getWorkspace(workspaceId);
    if (existing) {
      if (userId && existing.userId && existing.userId !== userId) {
        throw new Error('Workspace access denied');
      }
      return existing;
    }
  }
  return createWorkspace({ name: 'default', userId: userId || null });
}

/**
 * Export a consistent snapshot at a revision.
 */
async function exportWorkspace(workspaceId) {
  const ws = await getWorkspace(workspaceId);
  if (!ws) return null;
  const files = (await listFiles(workspaceId)) || {};
  const exportFiles = {};
  Object.values(files).forEach((f) => {
    if (f && f.type === 'file' && f.path) {
      exportFiles[f.path] = {
        content: f.content || '',
        encoding: f.encoding || 'utf8',
        truncated: !!f.truncated,
        binary: !!f.binary,
        hash: f.hash || Sync.contentHash(f),
      };
    }
  });
  return {
    workspace: ws,
    revision: ws.revision || 0,
    files: exportFiles,
    fileCount: Object.keys(exportFiles).length,
    exportedAt: nowIso(),
  };
}

module.exports = {
  createWorkspace,
  getWorkspace,
  listFiles,
  getFile,
  putFile,
  deleteFile,
  deleteFileTree,
  saveSnapshot,
  bumpRevision,
  ensureWorkspace,
  exportWorkspace,
  defaultFiles,
  defaultGit,
  encodePath,
  decodePath,
  Sync,
};
