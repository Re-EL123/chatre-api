'use strict';

const {
  getBackend,
  siteRef,
  nowIso,
  memory,
} = require('./firebase');

if (!memory.users) memory.users = new Map();
if (!memory.byok) memory.byok = new Map();

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function userRef(uid) {
  return siteRef().collection('users').doc(uid);
}

function byokRef(uid) {
  return userRef(uid).collection('secrets').doc('byok');
}

async function ensureUser(uid, email, extras) {
  if (!uid) throw new Error('uid required');
  const existing = await getUser(uid);
  if (existing) {
    const patch = {};
    if (email && existing.email !== email) patch.email = email;
    if (Object.keys(patch).length) {
      return updateUser(uid, patch);
    }
    return existing;
  }
  const row = {
    id: uid,
    email: email || '',
    displayName: (extras && extras.displayName) || '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    defaults: {
      provider: 'chatre',
      model: DEFAULT_MODEL,
    },
  };
  if (getBackend() === 'firestore') {
    await userRef(uid).set(row);
  } else {
    memory.users.set(uid, row);
  }
  return row;
}

async function getUser(uid) {
  if (!uid) return null;
  if (getBackend() === 'firestore') {
    const doc = await userRef(uid).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }
  return memory.users.get(uid) || null;
}

async function updateUser(uid, patch) {
  const existing = (await getUser(uid)) || { id: uid };
  const next = {
    ...existing,
    ...patch,
    id: uid,
    updatedAt: nowIso(),
  };
  if (patch.defaults) {
    next.defaults = {
      ...(existing.defaults || {}),
      ...patch.defaults,
    };
  }
  if (getBackend() === 'firestore') {
    await userRef(uid).set(next, { merge: true });
  } else {
    memory.users.set(uid, next);
  }
  return next;
}

async function getByokDoc(uid) {
  if (getBackend() === 'firestore') {
    const doc = await byokRef(uid).get();
    if (!doc.exists) return {};
    return doc.data() || {};
  }
  return memory.byok.get(uid) || {};
}

async function setByokProvider(uid, provider, blob) {
  const cur = await getByokDoc(uid);
  const next = { ...cur, [provider]: blob, updatedAt: nowIso() };
  if (getBackend() === 'firestore') {
    await byokRef(uid).set(next, { merge: true });
  } else {
    memory.byok.set(uid, next);
  }
  return next;
}

async function deleteByokProvider(uid, provider) {
  const cur = await getByokDoc(uid);
  if (cur[provider]) delete cur[provider];
  cur.updatedAt = nowIso();
  if (getBackend() === 'firestore') {
    await byokRef(uid).set(cur);
  } else {
    memory.byok.set(uid, cur);
  }
  return cur;
}

function byokConfiguredFlags(doc) {
  const providers = ['openrouter', 'anthropic', 'openai', 'google'];
  const out = {};
  providers.forEach((p) => {
    out[p] = !!(doc && doc[p] && doc[p].ciphertext);
  });
  return out;
}

module.exports = {
  DEFAULT_MODEL,
  ensureUser,
  getUser,
  updateUser,
  getByokDoc,
  setByokProvider,
  deleteByokProvider,
  byokConfiguredFlags,
};
