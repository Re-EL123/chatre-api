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

async function createWorkspace({ name } = {}) {
  const id = newId('ws');
  const meta = {
    id,
    name: name || 'default',
    cwd: '/home/user',
    git: defaultGit(),
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

async function putFile(workspaceId, file) {
  const path = file.path;
  if (getBackend() === 'firestore') {
    await siteRef()
      .collection('workspaces')
      .doc(workspaceId)
      .collection('files')
      .doc(encodePath(path))
      .set({ ...file, path, updatedAt: nowIso() }, { merge: true });
    await siteRef()
      .collection('workspaces')
      .doc(workspaceId)
      .set({ updatedAt: nowIso() }, { merge: true });
  } else {
    const ws = memory.workspaces.get(workspaceId);
    if (!ws) throw new Error('Workspace not found');
    ws.files.set(path, { ...file, path });
    ws.meta.updatedAt = nowIso();
  }
  return file;
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

async function saveSnapshot(workspaceId, { files, cwd, git }) {
  if (files) {
    for (const [p, f] of Object.entries(files)) {
      await putFile(workspaceId, f);
    }
  }
  const patch = { updatedAt: nowIso() };
  if (cwd) patch.cwd = cwd;
  if (git) patch.git = git;
  if (getBackend() === 'firestore') {
    await siteRef().collection('workspaces').doc(workspaceId).set(patch, { merge: true });
  } else {
    const ws = memory.workspaces.get(workspaceId);
    if (ws) Object.assign(ws.meta, patch);
  }
  return getWorkspace(workspaceId);
}

async function ensureWorkspace(workspaceId) {
  if (workspaceId) {
    const existing = await getWorkspace(workspaceId);
    if (existing) return existing;
  }
  return createWorkspace({ name: 'default' });
}

module.exports = {
  createWorkspace,
  getWorkspace,
  listFiles,
  getFile,
  putFile,
  deleteFile,
  saveSnapshot,
  ensureWorkspace,
  defaultFiles,
  defaultGit,
  encodePath,
  decodePath,
};
