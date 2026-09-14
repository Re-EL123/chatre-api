'use strict';

const {
  getBackend,
  siteRef,
  nowIso,
  memory,
} = require('./firebase');

if (!memory.users) memory.users = new Map();
if (!memory.byok) memory.byok = new Map();
if (!memory.connectors) memory.connectors = new Map();

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function userRef(uid) {
  return siteRef().collection('users').doc(uid);
}

function byokRef(uid) {
  return userRef(uid).collection('secrets').doc('byok');
}

function connectorsRef(uid) {
  return userRef(uid).collection('secrets').doc('connectors');
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
      autonomy: 'assist',
      preferByok: true,
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
  const providers = ['openrouter', 'aihubmix', 'zai', 'groq', 'deepseek', 'modelscope', 'mistral', 'xai', 'anthropic', 'openai', 'google', 'cursor'];
  const out = {};
  providers.forEach((p) => {
    out[p] = !!(doc && doc[p] && doc[p].ciphertext);
  });
  return out;
}

async function getConnectorsDoc(uid) {
  if (getBackend() === 'firestore') {
    const doc = await connectorsRef(uid).get();
    if (!doc.exists) return {};
    return doc.data() || {};
  }
  return memory.connectors.get(uid) || {};
}

async function setConnectorProvider(uid, provider, blob) {
  const cur = await getConnectorsDoc(uid);
  const next = { ...cur, [provider]: blob, updatedAt: nowIso() };
  if (getBackend() === 'firestore') {
    await connectorsRef(uid).set(next, { merge: true });
  } else {
    memory.connectors.set(uid, next);
  }
  return next;
}

async function deleteConnectorProvider(uid, provider) {
  const cur = await getConnectorsDoc(uid);
  if (cur[provider]) delete cur[provider];
  cur.updatedAt = nowIso();
  if (getBackend() === 'firestore') {
    await connectorsRef(uid).set(cur);
  } else {
    memory.connectors.set(uid, cur);
  }
  return cur;
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
  getConnectorsDoc,
  setConnectorProvider,
  deleteConnectorProvider,
  listCustomAgents,
  saveCustomAgent,
  deleteCustomAgent,
};

function listCustomAgents(user) {
  const list = (user && user.agents) || [];
  return Array.isArray(list) ? list : [];
}

async function saveCustomAgent(uid, agent) {
  const profile = (await getUser(uid)) || (await ensureUser(uid));
  const { normalizeCustomAgent } = require('./agents');
  const normalized = normalizeCustomAgent(agent);
  if (!normalized) throw new Error('Invalid agent');
  const list = listCustomAgents(profile).filter(
    (a) => a && a.name !== normalized.name && a.identifier !== normalized.name,
  );
  list.push({
    identifier: normalized.identifier,
    name: normalized.name,
    whenToUse: normalized.whenToUse,
    description: normalized.description,
    systemPrompt: normalized.prompt,
    prompt: normalized.prompt,
    mode: normalized.mode,
    color: normalized.color,
    steps: normalized.steps,
    permission: agent.permission || {},
    createdAt: nowIso(),
  });
  await updateUser(uid, { agents: list.slice(-40) });
  return normalized;
}

async function deleteCustomAgent(uid, name) {
  const profile = await getUser(uid);
  const id = String(name || '').toLowerCase();
  const list = listCustomAgents(profile).filter(
    (a) => a && a.name !== id && a.identifier !== id,
  );
  await updateUser(uid, { agents: list });
  return list;
}
