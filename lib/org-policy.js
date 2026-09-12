'use strict';

/**
 * Thin site-wide org policy — Cursor-core Phase 3.
 * Load from CHATRE_ORG_POLICY JSON env.
 *
 * Shape:
 * {
 *   "denyTools": ["create_pull_request"],
 *   "askTools": ["git_push"],
 *   "requireTests": false,
 *   "requireCiForPr": false,
 *   "multiRoot": true
 * }
 */

function loadOrgPolicy() {
  const raw = process.env.CHATRE_ORG_POLICY || '';
  if (!raw || !String(raw).trim()) {
    return {
      denyTools: [],
      askTools: [],
      requireTests: false,
      requireCiForPr: false,
      multiRoot: true,
    };
  }
  try {
    const o = JSON.parse(raw);
    return {
      denyTools: Array.isArray(o.denyTools) ? o.denyTools.map(String) : [],
      askTools: Array.isArray(o.askTools) ? o.askTools.map(String) : [],
      requireTests: !!o.requireTests,
      requireCiForPr: !!o.requireCiForPr,
      multiRoot: o.multiRoot !== false,
    };
  } catch {
    return {
      denyTools: [],
      askTools: [],
      requireTests: false,
      requireCiForPr: false,
      multiRoot: true,
    };
  }
}

function checkToolPolicy(tool, policy) {
  const p = policy || loadOrgPolicy();
  const name = String(tool || '');
  if (p.denyTools && p.denyTools.indexOf(name) >= 0) {
    return {
      ok: false,
      denied: true,
      error: 'Blocked by org policy: ' + name,
    };
  }
  if (p.askTools && p.askTools.indexOf(name) >= 0) {
    return { ok: true, ask: true };
  }
  return { ok: true, ask: false };
}

function allowsMultiRoot(policy) {
  const p = policy || loadOrgPolicy();
  return p.multiRoot !== false;
}

module.exports = {
  loadOrgPolicy,
  checkToolPolicy,
  allowsMultiRoot,
};
