'use strict';

/** In-process context index cache (revision-aware). */
const store = new Map();

function cacheKey(workspaceId) {
  return String(workspaceId || '');
}

function getCachedIndex(workspaceId, revision) {
  const row = store.get(cacheKey(workspaceId));
  if (!row) return null;
  if (revision != null && Number(row.revision) !== Number(revision)) return null;
  return row.index || null;
}

function setCachedIndex(workspaceId, revision, index) {
  store.set(cacheKey(workspaceId), {
    revision: Number(revision) || 0,
    index,
    at: Date.now(),
  });
  return index;
}

function clearCachedIndex(workspaceId) {
  store.delete(cacheKey(workspaceId));
}

module.exports = {
  getCachedIndex,
  setCachedIndex,
  clearCachedIndex,
};
