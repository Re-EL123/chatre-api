'use strict';

/**
 * Per-user memory and schedule stores (Firestore or in-memory).
 */

const { getBackend, siteRef, nowIso, memory } = require('./firebase');

if (!memory.userMemory) memory.userMemory = new Map();
if (!memory.userSchedules) memory.userSchedules = new Map();

function userRef(uid) {
  return siteRef().collection('users').doc(uid);
}

function memoryRef(uid) {
  return userRef(uid).collection('memory');
}

function schedulesRef(uid) {
  return userRef(uid).collection('schedules');
}

function makeId() {
  return 'sch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function memoryGet(uid, key) {
  if (!uid) return { ok: false, error: 'Signed-in user required' };
  if (getBackend() === 'firestore') {
    if (key) {
      const doc = await memoryRef(uid).doc(String(key)).get();
      if (!doc.exists) return { ok: true, key: String(key), value: null };
      const data = doc.data() || {};
      return { ok: true, key: String(key), value: data.value, updatedAt: data.updatedAt };
    }
    const snap = await memoryRef(uid).limit(100).get();
    const items = [];
    snap.forEach((d) => {
      const data = d.data() || {};
      items.push({ key: d.id, value: data.value, updatedAt: data.updatedAt });
    });
    return { ok: true, items };
  }
  const bag = memory.userMemory.get(uid) || {};
  if (key) {
    const row = bag[String(key)];
    return {
      ok: true,
      key: String(key),
      value: row ? row.value : null,
      updatedAt: row && row.updatedAt,
    };
  }
  return {
    ok: true,
    items: Object.keys(bag).map((k) => ({
      key: k,
      value: bag[k].value,
      updatedAt: bag[k].updatedAt,
    })),
  };
}

async function memorySet(uid, key, value) {
  if (!uid) return { ok: false, error: 'Signed-in user required' };
  const k = String(key || '').trim().slice(0, 120);
  if (!k) return { ok: false, error: 'key required' };
  const row = {
    key: k,
    value: typeof value === 'string' ? value.slice(0, 8000) : value,
    updatedAt: nowIso(),
  };
  if (getBackend() === 'firestore') {
    await memoryRef(uid).doc(k).set(row, { merge: true });
  } else {
    const bag = memory.userMemory.get(uid) || {};
    bag[k] = row;
    memory.userMemory.set(uid, bag);
  }
  return { ok: true, key: k, updatedAt: row.updatedAt };
}

async function memoryDelete(uid, key) {
  if (!uid) return { ok: false, error: 'Signed-in user required' };
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'key required' };
  if (getBackend() === 'firestore') {
    await memoryRef(uid).doc(k).delete();
  } else {
    const bag = memory.userMemory.get(uid) || {};
    delete bag[k];
    memory.userMemory.set(uid, bag);
  }
  return { ok: true, key: k, deleted: true };
}

function parseWhen(when) {
  if (!when) return null;
  if (typeof when === 'number' && Number.isFinite(when)) {
    return new Date(when).toISOString();
  }
  const s = String(when).trim();
  const asDate = new Date(s);
  if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  const rel = s.match(/^in\s+(\d+)\s*(m|min|mins|minutes|h|hr|hours|d|days)\b/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    let ms = n * 60000;
    if (unit.startsWith('h')) ms = n * 3600000;
    if (unit.startsWith('d')) ms = n * 86400000;
    return new Date(Date.now() + ms).toISOString();
  }
  return null;
}

async function scheduleCreate(uid, params) {
  if (!uid) return { ok: false, error: 'Signed-in user required' };
  const p = params || {};
  const whenIso = parseWhen(p.when || p.at || p.due);
  if (!whenIso) {
    return {
      ok: false,
      error: 'when required (ISO date or "in 30m" / "in 2h")',
    };
  }
  const id = String(p.id || makeId());
  const row = {
    id,
    message: String(p.message || p.text || p.body || '').slice(0, 2000),
    when: whenIso,
    cron: p.cron ? String(p.cron).slice(0, 80) : null,
    status: 'scheduled',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (!row.message) return { ok: false, error: 'message required' };
  if (getBackend() === 'firestore') {
    await schedulesRef(uid).doc(id).set(row);
  } else {
    const list = memory.userSchedules.get(uid) || [];
    list.push(row);
    memory.userSchedules.set(uid, list);
  }
  return { ok: true, schedule: row };
}

async function scheduleList(uid) {
  if (!uid) return { ok: false, error: 'Signed-in user required' };
  if (getBackend() === 'firestore') {
    const snap = await schedulesRef(uid).limit(100).get();
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    items.sort((a, b) => String(a.when).localeCompare(String(b.when)));
    return { ok: true, schedules: items };
  }
  const list = (memory.userSchedules.get(uid) || []).slice();
  list.sort((a, b) => String(a.when).localeCompare(String(b.when)));
  return { ok: true, schedules: list };
}

async function scheduleCancel(uid, id) {
  if (!uid) return { ok: false, error: 'Signed-in user required' };
  const sid = String(id || '').trim();
  if (!sid) return { ok: false, error: 'id required' };
  if (getBackend() === 'firestore') {
    await schedulesRef(uid).doc(sid).set(
      { status: 'cancelled', updatedAt: nowIso() },
      { merge: true },
    );
  } else {
    const list = memory.userSchedules.get(uid) || [];
    const row = list.find((x) => x.id === sid);
    if (row) {
      row.status = 'cancelled';
      row.updatedAt = nowIso();
    }
  }
  return { ok: true, id: sid, status: 'cancelled' };
}

async function scheduleDue(uid) {
  if (!uid) return { ok: false, error: 'Signed-in user required' };
  const now = Date.now();
  const listed = await scheduleList(uid);
  const due = (listed.schedules || []).filter((s) => {
    if (s.status !== 'scheduled') return false;
    return new Date(s.when).getTime() <= now;
  });
  for (const s of due) {
    if (getBackend() === 'firestore') {
      await schedulesRef(uid).doc(s.id).set(
        { status: 'delivered', deliveredAt: nowIso(), updatedAt: nowIso() },
        { merge: true },
      );
    } else {
      s.status = 'delivered';
      s.deliveredAt = nowIso();
      s.updatedAt = nowIso();
    }
  }
  return { ok: true, due, count: due.length };
}

module.exports = {
  memoryGet,
  memorySet,
  memoryDelete,
  scheduleCreate,
  scheduleList,
  scheduleCancel,
  scheduleDue,
  parseWhen,
};
