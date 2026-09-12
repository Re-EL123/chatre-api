'use strict';

/**
 * Per task_type step + wall-clock budgets.
 */

const STEP_CAPS = {
  chat: 1,
  question: 4,
  research: 8,
  browser: 10,
  build: 10,
  debug: 10,
  document: 6,
  git: 6,
  run: 6,
  mixed: 8,
};

const MS_CAPS = {
  chat: 20000,
  question: 45000,
  research: 55000,
  browser: 55000,
  build: 55000,
  debug: 55000,
  document: 50000,
  git: 45000,
  run: 45000,
  mixed: 55000,
};

function budgetsForTaskType(taskType, briefingMaxSteps, budgetMsOverride) {
  const t = String(taskType || 'mixed').toLowerCase();
  const stepCap = STEP_CAPS[t] != null ? STEP_CAPS[t] : STEP_CAPS.mixed;
  const msCap = MS_CAPS[t] != null ? MS_CAPS[t] : MS_CAPS.mixed;
  let maxSteps = stepCap;
  if (briefingMaxSteps) {
    maxSteps = Math.min(stepCap, Number(briefingMaxSteps) || stepCap);
  }
  const budgetMs = budgetMsOverride
    ? Math.min(Number(budgetMsOverride) || msCap, msCap)
    : msCap;
  return { maxSteps, budgetMs, taskType: t, stepCap, msCap };
}

module.exports = { budgetsForTaskType, STEP_CAPS, MS_CAPS };
