'use strict';

/**
 * Role-based model routing + soft spend caps for enterprise runs.
 *
 * Env (optional):
 *   CHATRE_MODEL_STRATEGY=...
 *   CHATRE_MODEL_EXECUTE=...
 *   CHATRE_MODEL_MONITOR=...
 *   CHATRE_MODEL_VERIFY=...
 *   CHATRE_MODEL_RESEARCH=...
 *   CHATRE_RUN_TOKEN_BUDGET=180000
 */

const ROLE_ENV = {
  strategy: 'CHATRE_MODEL_STRATEGY',
  plan: 'CHATRE_MODEL_STRATEGY',
  intake: 'CHATRE_MODEL_STRATEGY',
  execute: 'CHATRE_MODEL_EXECUTE',
  build: 'CHATRE_MODEL_EXECUTE',
  general: 'CHATRE_MODEL_EXECUTE',
  specialist: 'CHATRE_MODEL_EXECUTE',
  monitor: 'CHATRE_MODEL_MONITOR',
  critic: 'CHATRE_MODEL_MONITOR',
  verify: 'CHATRE_MODEL_VERIFY',
  research: 'CHATRE_MODEL_RESEARCH',
  explore: 'CHATRE_MODEL_RESEARCH',
};

function defaultTokenBudget() {
  return Math.max(
    20000,
    Number(process.env.CHATRE_RUN_TOKEN_BUDGET || 180000) || 180000,
  );
}

function resolveModelForRole(role, opts) {
  const o = opts || {};
  const r = String(role || 'execute').toLowerCase();
  const envKey = ROLE_ENV[r];
  const fromEnv = envKey ? String(process.env[envKey] || '').trim() : '';
  if (fromEnv) return fromEnv;
  if (o.overrides && o.overrides[r]) return o.overrides[r];
  // Fall back to session model (Workers AI / BYOK default)
  return o.defaultModel || null;
}

function createSpendTracker(opts) {
  const o = opts || {};
  const budget = o.tokenBudget || defaultTokenBudget();
  return {
    budget,
    promptTokens: 0,
    completionTokens: 0,
    add(usage) {
      const u = usage || {};
      this.promptTokens += Number(u.prompt_tokens || u.promptTokens || 0) || 0;
      this.completionTokens +=
        Number(u.completion_tokens || u.completionTokens || 0) || 0;
    },
    total() {
      return this.promptTokens + this.completionTokens;
    },
    remaining() {
      return Math.max(0, this.budget - this.total());
    },
    overBudget() {
      return this.total() >= this.budget;
    },
    snapshot() {
      return {
        budget: this.budget,
        promptTokens: this.promptTokens,
        completionTokens: this.completionTokens,
        total: this.total(),
        remaining: this.remaining(),
        overBudget: this.overBudget(),
      };
    },
  };
}

function escalateOnFailure(role, failCount, opts) {
  const o = opts || {};
  if ((failCount || 0) < 2) return resolveModelForRole(role, o);
  // Prefer strategist-tier model after repeated failures
  return (
    resolveModelForRole('strategy', o) ||
    resolveModelForRole(role, o) ||
    o.defaultModel ||
    null
  );
}

module.exports = {
  ROLE_ENV,
  resolveModelForRole,
  createSpendTracker,
  escalateOnFailure,
  defaultTokenBudget,
};
