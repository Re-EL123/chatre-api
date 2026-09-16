'use strict';

/** In-process context index cache (revision-aware). */
const store = new Map();

function cacheKey(workspaceId) {
  return String(workspaceId || '');
}

function getCachedIndex(workspaceId, revision, opts) {
  const row = store.get(cacheKey(workspaceId));
  if (!row) return null;
  if (revision != null && Number(row.revision) !== Number(revision)) return null;
  const index = row.index || null;
  if (!index) return null;
  const wantEngine = opts && opts.engine;
  if (wantEngine && index.engine && index.engine !== wantEngine) return null;
  // Dense half requires vectors; reject pre-v3 / embed:off caches when dense expected
  if (opts && opts.requireDense) {
    const sample = index.chunks && index.chunks[0];
    if (!sample || !sample.vec) return null;
  }
  return index;
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
