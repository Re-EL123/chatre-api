'use strict';

/**
 * Desktop companion job bridge.
 * Local companion heartbeats + polls jobs; cloud agent enqueues actions.
 */

const { getBackend, siteRef, memory, nowIso } = require('./firebase');
const { newId } = require('./http');

if (!memory.companions) memory.companions = new Map();
if (!memory.companionJobs) memory.companionJobs = new Map();

const ONLINE_MS = 45_000;
const DEFAULT_COMPANION = 'main';
const JOB_TTL_MS = 10 * 60 * 1000;

function companionIdFrom(raw) {
  const id = String(raw || DEFAULT_COMPANION)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 40);
  return id || DEFAULT_COMPANION;
}

async function cleanupExpiredJobs(companionId) {
  const cutoff = Date.now() - JOB_TTL_MS;
  const id = companionId ? companionIdFrom(companionId) : null;
  if (getBackend() === 'firestore') {
    try {
      let q = siteRef().collection('companionJobs').limit(40);
      if (id) q = q.where('companionId', '==', id);
      const snap = await q.get();
      for (const doc of snap.docs) {
        const d = doc.data() || {};
        const age = Number(d.createdMs || 0);
        const stale =
          age &&
          age < cutoff &&
          (d.status === 'pending' || d.status === 'running');
        if (stale) {
          await doc.ref.set(
            {
              status: 'expired',
              completedAt: nowIso(),
              result: { ok: false, error: 'Job TTL expired' },
            },
            { merge: true },
          );
        }
      }
    } catch {
      /* ignore */
    }
    return;
  }
  for (const [jid, j] of memory.companionJobs.entries()) {
    if (id && j.companionId !== id) continue;
    if (
      j.createdMs < cutoff &&
      (j.status === 'pending' || j.status === 'running')
    ) {
      j.status = 'expired';
      j.result = { ok: false, error: 'Job TTL expired' };
      memory.companionJobs.set(jid, j);
    }
  }
}

async function heartbeat(companionId, caps) {
  const id = companionIdFrom(companionId);
  await cleanupExpiredJobs(id);
  const row = {
    id,
    lastSeen: nowIso(),
    lastSeenMs: Date.now(),
    caps: Array.isArray(caps) ? caps.slice(0, 20) : [],
    platform: process.platform,
  };
  if (getBackend() === 'firestore') {
    await siteRef().collection('companions').doc(id).set(row, { merge: true });
  } else {
    memory.companions.set(id, row);
  }
  return { ok: true, companionId: id, online: true };
}

async function getCompanion(companionId) {
  const id = companionIdFrom(companionId);
  if (getBackend() === 'firestore') {
    const doc = await siteRef().collection('companions').doc(id).get();
    return doc.exists ? doc.data() : null;
  }
  return memory.companions.get(id) || null;
}

async function isOnline(companionId) {
  const c = await getCompanion(companionId);
  if (!c || !c.lastSeenMs) return false;
  return Date.now() - Number(c.lastSeenMs) < ONLINE_MS;
}

async function enqueueJob({ companionId, action, params, tool }) {
  const id = companionIdFrom(companionId);
  const jobId = newId('cjob');
  const job = {
    id: jobId,
    companionId: id,
    action: String(action || ''),
    tool: String(tool || action || ''),
    params: params && typeof params === 'object' ? params : {},
    status: 'pending',
    createdAt: nowIso(),
    createdMs: Date.now(),
    result: null,
  };
  if (getBackend() === 'firestore') {
    await siteRef().collection('companionJobs').doc(jobId).set(job);
  } else {
    memory.companionJobs.set(jobId, job);
  }
  return job;
}

async function getJob(jobId) {
  if (getBackend() === 'firestore') {
    const doc = await siteRef().collection('companionJobs').doc(String(jobId)).get();
    return doc.exists ? doc.data() : null;
  }
  return memory.companionJobs.get(String(jobId)) || null;
}

async function claimPending(companionId, limit) {
  const id = companionIdFrom(companionId);
  const max = Math.min(Math.max(Number(limit) || 3, 1), 5);
  if (getBackend() === 'firestore') {
    const snap = await siteRef()
      .collection('companionJobs')
      .where('companionId', '==', id)
      .limit(40)
      .get();
    const sorted = snap.docs
      .map((d) => ({ ref: d.ref, data: d.data() }))
      .filter((x) => x.data && x.data.status === 'pending')
      .sort((a, b) => Number(a.data.createdMs || 0) - Number(b.data.createdMs || 0))
      .slice(0, max);
    const jobs = [];
    for (const item of sorted) {
      await item.ref.set(
        { status: 'running', claimedAt: nowIso() },
        { merge: true },
      );
      jobs.push({ ...item.data, status: 'running' });
    }
    return jobs;
  }
  const all = [...memory.companionJobs.values()]
    .filter((j) => j.companionId === id && j.status === 'pending')
    .sort((a, b) => a.createdMs - b.createdMs)
    .slice(0, max);
  for (const j of all) {
    j.status = 'running';
    j.claimedAt = nowIso();
    memory.companionJobs.set(j.id, j);
  }
  return all;
}

async function completeJob(jobId, result) {
  const job = await getJob(jobId);
  if (!job) return { ok: false, error: 'Unknown job' };
  const next = {
    ...job,
    status: result && result.ok === false ? 'failed' : 'done',
    completedAt: nowIso(),
    result: sanitizeResult(result),
  };
  if (getBackend() === 'firestore') {
    await siteRef().collection('companionJobs').doc(String(jobId)).set(next, {
      merge: true,
    });
  } else {
    memory.companionJobs.set(String(jobId), next);
  }
  return { ok: true, job: next };
}

function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'empty' };
  const out = { ...result };
  if (out.screenshot_base64) {
    const s = String(out.screenshot_base64);
    if (s.length > 900_000) {
      out.screenshot_base64 = s.slice(0, 900_000);
      out.truncated = true;
    }
  }
  if (out.text) out.text = String(out.text).slice(0, 20000);
  return out;
}

async function awaitJob(jobId, timeoutMs) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 25000, 3000), 55000);
  while (Date.now() < deadline) {
    const job = await getJob(jobId);
    if (!job) return { ok: false, error: 'Job disappeared' };
    if (job.status === 'done' || job.status === 'failed') {
      return {
        ok: job.status === 'done' && !(job.result && job.result.ok === false),
        ...(job.result || {}),
        jobId,
        status: job.status,
      };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return {
    ok: false,
    error:
      'Desktop companion did not answer in time. Is it running and bridged to the API?',
    jobId,
    timeout: true,
  };
}

async function status(companionId) {
  const id = companionIdFrom(companionId);
  const c = await getCompanion(id);
  const online = await isOnline(id);
  return {
    ok: true,
    companionId: id,
    online,
    lastSeen: c && c.lastSeen,
    caps: (c && c.caps) || [],
    backend: getBackend(),
  };
}

/**
 * Run a desktop action via bridge (enqueue + wait).
 */
async function runViaBridge({ action, params, tool, companionId, timeoutMs }) {
  const online = await isOnline(companionId);
  if (!online) {
    return {
      ok: false,
      tool: tool || action,
      error:
        'Desktop companion offline. In the chatre1 repo run: CHATRE_API_BASE=<api> CHATRE_API_TOKEN=<token> npm run companion:start. UI shows “Desktop off” until it heartbeats.',
      companion_offline: true,
      hint: 'companion_offline',
    };
  }
  const job = await enqueueJob({ companionId, action, params, tool });
  return awaitJob(job.id, timeoutMs);
}

module.exports = {
  heartbeat,
  claimPending,
  completeJob,
  awaitJob,
  enqueueJob,
  status,
  isOnline,
  runViaBridge,
  companionIdFrom,
  DEFAULT_COMPANION,
  cleanupExpiredJobs,
  JOB_TTL_MS,
};
