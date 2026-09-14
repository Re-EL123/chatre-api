'use strict';

const {
  getBackend,
  siteRef,
  nowIso,
  memory,
  admin,
} = require('./firebase');
const { newId } = require('./http');

async function listThreads(limit = 50, { userId } = {}) {
  if (getBackend() === 'firestore') {
    let q = siteRef().collection('threads');
    if (userId) {
      q = q.where('userId', '==', userId);
    }
    const snap = await q.limit(Math.min(limit * 2, 200)).get();
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, limit);
  }
  return [...memory.threads.values()]
    .filter((t) => !userId || t.userId === userId)
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

async function createThread({ title, model, workspaceId, userId, provider } = {}) {
  const id = newId('thr');
  const row = {
    id,
    title: title || 'New chat',
    model: model || '',
    provider: provider || 'chatre',
    workspaceId: workspaceId || null,
    userId: userId || null,
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

/**
 * Append a capped understanding outcome record (telemetry for intake quality).
 */
async function appendUnderstandingOutcome(threadId, record) {
  const thr = await getThread(threadId);
  if (!thr) return null;
  const UnderstandingLog = require('./understanding-log');
  const log = UnderstandingLog.appendToLog(thr.understandingLog, record);
  const summary = UnderstandingLog.summarizeUnderstandingLog(log);
  return updateThread(threadId, {
    understandingLog: log,
    understandingSummary: summary,
    lastUnderstanding: record,
  });
}

/**
 * Durable thread corrections (server-side, survives finishRun).
 */
async function mergeDurableCorrections(threadId, corrections) {
  const thr = await getThread(threadId);
  if (!thr) return null;
  const Understanding = require('./understanding');
  const incoming = Understanding.asStringList(corrections);
  const prev = Understanding.asStringList(thr.durableCorrections);
  const merged = [];
  incoming.concat(prev).forEach((c) => {
    if (merged.indexOf(c) < 0) merged.push(c);
  });
  return updateThread(threadId, {
    durableCorrections: merged.slice(0, 24),
  });
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
  appendUnderstandingOutcome,
  mergeDurableCorrections,
};
