'use strict';

/**
 * Layer 3 — Runtime verification loop helpers.
 * Used by the agent after mutating writes; no new API route.
 */

function shouldAutoVerify(toolName, taskType) {
  const t = String(toolName || '');
  const tt = String(taskType || '').toLowerCase();
  if (!/^(write_file|patch_file|apply_patch|create_pdf|create_document)$/.test(t)) {
    return false;
  }
  return ['build', 'debug', 'document', 'mixed', 'run'].indexOf(tt) >= 0;
}

function nextVerifySteps(ctx) {
  const c = ctx || {};
  const steps = [];
  const tt = String(c.taskType || c.task_type || '').toLowerCase();
  if (tt === 'build' || tt === 'debug' || tt === 'mixed') {
    steps.push({ tool: 'preview_project', reason: 'Live localhost smoke after edits' });
    steps.push({ tool: 'run_tests', reason: 'Confirm tests still pass' });
  }
  if (tt === 'document') {
    steps.push({ tool: 'list_directory', reason: 'Confirm document path exists' });
  }
  if (c.diagnostics && c.diagnostics.length) {
    steps.push({ tool: 'repo_diagnostics', reason: 'Re-check problems panel' });
  }
  return steps.slice(0, 3);
}

function formatVerifyHint(steps) {
  if (!steps || !steps.length) return '';
  return (
    '# Auto-verify (Layer 3)\n' +
    steps.map((s, i) => i + 1 + '. Call ' + s.tool + ' — ' + s.reason).join('\n')
  );
}

module.exports = {
  shouldAutoVerify,
  nextVerifySteps,
  formatVerifyHint,
};
