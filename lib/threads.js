'use strict';

const {
  getBackend,
  siteRef,
  nowIso,
  memory,
  admin,
} = require('./firebase');
const { newId } = require('./http');

async function listThreads(limit = 50) {
  if (getBackend() === 'firestore') {
    const snap = await siteRef()
      .collection('threads')
      .orderBy('updatedAt', 'desc')
      .limit(Math.min(limit, 100))
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return [...memory.threads.values()]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
}

async function getThread(threadId) {
  if (getBackend() === 'firestore') {
    const doc = await siteRef().collection('threads').doc(threadId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }
  return memory.threads.get(threadId) || null;
}

async function createThread({ title, model, workspaceId } = {}) {
  const id = newId('thr');
  const row = {
    id,
    title: title || 'New chat',
    model: model || '',
    workspaceId: workspaceId || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (getBackend() === 'firestore') {
    await siteRef().collection('threads').doc(id).set(row);
  } else {
    memory.threads.set(id, row);
    memory.messages.set(id, []);
  }
  return row;
}

async function updateThread(threadId, patch) {
  const existing = await getThread(threadId);
  if (!existing) return null;
  const next = { ...existing, ...patch, updatedAt: nowIso(), id: threadId };
  if (getBackend() === 'firestore') {
    await siteRef().collection('threads').doc(threadId).set(next, { merge: true });
  } else {
    memory.threads.set(threadId, next);
  }
  return next;
}

async function deleteThread(threadId) {
  if (getBackend() === 'firestore') {
    const msgs = await siteRef()
      .collection('threads')
      .doc(threadId)
      .collection('messages')
      .limit(500)
      .get();
    const batch = admin().firestore().batch();
    msgs.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(siteRef().collection('threads').doc(threadId));
    await batch.commit();
  } else {
    memory.threads.delete(threadId);
    memory.messages.delete(threadId);
  }
  return true;
}

async function listMessages(threadId, limit = 200) {
  if (getBackend() === 'firestore') {
    const snap = await siteRef()
      .collection('threads')
      .doc(threadId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limit(Math.min(limit, 500))
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return (memory.messages.get(threadId) || []).slice(-limit);
}

async function appendMessage(threadId, { role, content, meta }) {
  const id = newId('msg');
  const row = {
    id,
    role,
    content: String(content || ''),
    meta: meta || null,
    createdAt: nowIso(),
  };
  if (getBackend() === 'firestore') {
    await siteRef()
      .collection('threads')
      .doc(threadId)
      .collection('messages')
      .doc(id)
      .set(row);
    await siteRef().collection('threads').doc(threadId).set(
      { updatedAt: nowIso() },
      { merge: true },
    );
  } else {
    const list = memory.messages.get(threadId) || [];
    list.push(row);
    memory.messages.set(threadId, list);
    const thr = memory.threads.get(threadId);
    if (thr) {
      thr.updatedAt = nowIso();
      memory.threads.set(threadId, thr);
    }
  }
  return row;
}

/**
 * Persist model + usage on the thread (lastUsage + capped usageHistory).
 */
async function recordUsage(threadId, usage, model) {
  const thr = await getThread(threadId);
  if (!thr) return null;
  const entry = {
    at: nowIso(),
    model: model || (usage && usage.model) || thr.model || '',
    steps: (usage && usage.steps) || 0,
    toolsUsed: (usage && usage.toolsUsed) || 0,
    promptTokensEst: (usage && usage.promptTokensEst) || 0,
    completionTokensEst: (usage && usage.completionTokensEst) || 0,
    totalTokensEst: (usage && usage.totalTokensEst) || 0,
  };
  const history = Array.isArray(thr.usageHistory) ? thr.usageHistory.slice() : [];
  history.push(entry);
  while (history.length > 40) history.shift();
  return updateThread(threadId, {
    model: entry.model,
    lastUsage: entry,
    usageHistory: history,
  });
}

/**
 * Save / clear durable agent-run checkpoint for resume after timeout.
 */
async function saveAgentRun(threadId, agentRun) {
  return updateThread(threadId, { agentRun: agentRun || null });
}

module.exports = {
  listThreads,
  getThread,
  createThread,
  updateThread,
  deleteThread,
  listMessages,
  appendMessage,
  recordUsage,
  saveAgentRun,
};
