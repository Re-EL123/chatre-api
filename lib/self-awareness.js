'use strict';

/**
 * OpenCode-inspired self-awareness helpers for Chatre.
 * Keeps the model oriented mid-run: status snapshots, skill catalog,
 * doom-loop gate, max-steps stop, nested AGENTS, SystemContext-lite updates.
 */

const MAX_STEPS_PROMPT = `CRITICAL — MAXIMUM STEPS REACHED

Tools are disabled until the next user message. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT emit tool calls (no \`\`\`tool blocks, no function calls)
2. MUST summarize progress vs done_when with real evidence (paths, tool outcomes)
3. List remaining open work honestly — do not claim done without proof

Response must include:
- That the step budget for this run is exhausted
- What was accomplished (concrete paths / proofs)
- What remains vs done_when
- Recommended next user action

Any attempt to use tools is a critical violation. Text ONLY.`;

function toolCallFingerprint(call) {
  if (!call || !call.tool) return '';
  try {
    return call.tool + '::' + JSON.stringify(call.params || {});
  } catch {
    return String(call.tool);
  }
}

/**
 * Detect 3 identical consecutive tool calls (OpenCode doom_loop).
 * Returns { doom: true, tool, hint } or { doom: false }.
 */
function detectDoomLoop(recentFingerprints, nextCall) {
  const fp = toolCallFingerprint(nextCall);
  if (!fp) return { doom: false };
  const hist = Array.isArray(recentFingerprints) ? recentFingerprints : [];
  if (hist.length < 2) return { doom: false, fingerprint: fp };
  const a = hist[hist.length - 1];
  const b = hist[hist.length - 2];
  if (a === fp && b === fp) {
    return {
      doom: true,
      fingerprint: fp,
      tool: nextCall.tool,
      hint:
        'Doom loop: "' +
        nextCall.tool +
        '" repeated 3× with identical args. Change approach, use a different tool, or ask the user — do not retry the same call.',
    };
  }
  return { doom: false, fingerprint: fp };
}

/**
 * Same tool name failing repeatedly (even with different args) — invent-path loops.
 */
function detectRepeatedToolFails(lastFailures, nextTool, threshold) {
  const t = String(nextTool || '');
  if (!t) return { doom: false };
  const lim = threshold || 2;
  const fails = Array.isArray(lastFailures) ? lastFailures : [];
  if (fails.length < lim) return { doom: false };
  const recent = fails.slice(-lim);
  const allSame = recent.every((line) => String(line).indexOf(t + ':') === 0);
  if (!allSame) return { doom: false };
  return {
    doom: true,
    tool: t,
    hint:
      'Repeated failures of "' +
      t +
      '". Stop guessing paths. Call view_tree or use workspace inventory paths only. For localhost HTML use preview_project, not browser tabs.',
  };
}

function pushDoomFingerprint(ctx, fingerprint) {
  if (!ctx || !fingerprint) return;
  if (!Array.isArray(ctx._toolFingerprints)) ctx._toolFingerprints = [];
  ctx._toolFingerprints.push(fingerprint);
  if (ctx._toolFingerprints.length > 12) {
    ctx._toolFingerprints = ctx._toolFingerprints.slice(-12);
  }
}

/**
 * Compact per-step status for Continue feeds (OpenCode <env> + Chatre blackboard).
 */
function formatStatusSnapshot(ctx, opts) {
  const o = opts || {};
  const bb = (ctx && ctx.blackboard) || {};
  const workflow = o.workflow || {};
  const step = Number(o.step != null ? o.step : 0);
  const maxSteps = Number(o.maxSteps != null ? o.maxSteps : 0);
  const toolsUsed = Number(o.toolsUsed != null ? o.toolsUsed : 0);
  const remaining = maxSteps > 0 ? Math.max(0, maxSteps - step) : null;
  const todos = (ctx && ctx.todos) || bb.todos || [];
  const open = todos.filter((t) => t && t.status !== 'done');
  const done = todos.filter((t) => t && t.status === 'done');
  const failures = (ctx && ctx.lastFailures) || [];
  const touched = (ctx && ctx.filesTouched) || bb.filesTouched || [];
  const probs =
    (ctx && ctx.lastDiagnostics && ctx.lastDiagnostics.problems) || [];

  const lines = [
    '# Run status (authoritative — stay aligned)',
    'Step: ' +
      step +
      (maxSteps ? '/' + maxSteps : '') +
      (remaining != null ? ' · remaining ' + remaining : '') +
      ' · tools_used ' +
      toolsUsed,
    'Phase: ' +
      (bb.phase || '(none)') +
      ' · owner ' +
      (bb.phaseOwner || '?') +
      ' · workflow explored=' +
      !!workflow.explored +
      ' planned=' +
      !!workflow.planned +
      ' implemented=' +
      !!workflow.implemented +
      ' verified=' +
      !!workflow.verified,
    'Goal: ' + String((bb.goal || (ctx && ctx.briefing && ctx.briefing.goal) || '')).slice(0, 400),
    'Done when: ' +
      String(
        bb.doneWhen || (ctx && ctx.doneWhen) || '',
      ).slice(0, 400),
    'Delivery: ' +
      ((ctx && ctx.deliverySuccess) || (bb && bb.previewOk)
        ? 'success/evidence present'
        : 'not yet proven'),
    'Preview: ' +
      (bb.previewOk
        ? 'ok'
        : bb.previewErrors && bb.previewErrors.length
          ? 'FAIL'
          : 'pending'),
    'Active project: ' +
      ((ctx && ctx.activeProject) || '(none)') +
      ' · cwd ' +
      ((ctx && ctx.cwd) || '/home/user'),
    'Todos: ' + done.length + ' done · ' + open.length + ' open',
  ];

  if (bb.intentContract) {
    lines.push('Intent: ' + String(bb.intentContract).slice(0, 280));
  }
  if (bb.understandingConfidence != null && !Number.isNaN(bb.understandingConfidence)) {
    lines.push('Understanding confidence: ' + bb.understandingConfidence);
  }
  if (open.length) {
    lines.push('Open todos:');
    open.slice(0, 10).forEach((t) => {
      lines.push(
        '- [' +
          (t.status === 'in_progress' ? '~' : ' ') +
          '] ' +
          t.id +
          ': ' +
          String(t.content || '').slice(0, 120),
      );
    });
  }
  if (touched.length) {
    lines.push('Files touched: ' + touched.slice(-14).join(', '));
  }
  if (failures.length) {
    lines.push('Recent failures:');
    failures.slice(-4).forEach((f) => lines.push('- ' + String(f).slice(0, 160)));
  }
  if (probs.length) {
    lines.push('Open problems (' + probs.length + '):');
    probs.slice(0, 5).forEach((pr) => {
      lines.push(
        '- ' +
          (pr.file || '') +
          ':' +
          (pr.line || 1) +
          ' ' +
          String(pr.message || '').slice(0, 100),
      );
    });
  }
  if (bb.userCorrections && bb.userCorrections.length) {
    lines.push('User corrections (must honor):');
    bb.userCorrections.slice(-4).forEach((c) => {
      lines.push('- ' + String(c).slice(0, 160));
    });
  }

  lines.push(
    'Continue. Mark todos done. Prefer workspace delivery tools. Verify done_when with evidence before a final summary WITHOUT tools.',
  );
  const out = lines.join('\n');
  const cap = o.limit || 3500;
  return out.length > cap ? out.slice(0, cap) + '\n…' : out;
}

/**
 * Skill catalog (names + one-line guides). Bodies load via use_skill.
 */
function formatSkillCatalog(skillGuides, activeNames, limit) {
  const guides = skillGuides || {};
  const names = Object.keys(guides).sort();
  const active = Array.isArray(activeNames) ? activeNames.map(String) : [];
  const lines = [
    '# Skills catalog (use use_skill to load a full playbook)',
    'Available: ' + names.join(', '),
  ];
  if (active.length) {
    lines.push('Active this run: ' + active.join(', '));
    active.forEach((n) => {
      if (guides[n]) lines.push('- ' + guides[n]);
    });
  } else {
    names.slice(0, 8).forEach((n) => {
      lines.push('- ' + guides[n]);
    });
  }
  const out = lines.join('\n');
  const cap = limit || 2000;
  return out.length > cap ? out.slice(0, cap) + '\n…' : out;
}

/**
 * Walk up from a file path looking for AGENTS.md (OpenCode nested instructions).
 */
function findNearestAgentsMd(files, filePath, alreadyAttached) {
  const map = files || {};
  const attached = alreadyAttached || new Set();
  let dir = String(filePath || '');
  if (!dir || dir === '/') return null;
  // Start from parent of the file
  if (map[dir] && map[dir].type === 'file') {
    const slash = dir.lastIndexOf('/');
    dir = slash > 0 ? dir.slice(0, slash) : '/';
  }
  const seen = new Set();
  while (dir && !seen.has(dir)) {
    seen.add(dir);
    const agentsPath = (dir === '/' ? '' : dir) + '/AGENTS.md';
    const normalized = agentsPath.replace(/\/+/g, '/') || '/AGENTS.md';
    if (!attached.has(normalized) && map[normalized] && map[normalized].type === 'file') {
      const content = String(map[normalized].content || '').trim();
      if (content) {
        return {
          path: normalized,
          text:
            '<system-reminder>\nNested AGENTS.md at ' +
            normalized +
            ' (authoritative for this subtree):\n' +
            content.slice(0, 2500) +
            '\n</system-reminder>',
        };
      }
    }
    if (dir === '/' || dir === '/home/user') break;
    const slash = dir.lastIndexOf('/');
    dir = slash > 0 ? dir.slice(0, slash) : '/';
  }
  return null;
}

/**
 * SystemContext-lite: fingerprint refreshable ambient state.
 */
function contextFingerprint(ctx) {
  const bb = (ctx && ctx.blackboard) || {};
  const probs =
    (ctx && ctx.lastDiagnostics && ctx.lastDiagnostics.problems) || [];
  return [
    (ctx && ctx.cwd) || '',
    (ctx && ctx.activeProject) || '',
    bb.phase || '',
    bb.planApproved ? '1' : '0',
    (ctx && ctx.deliverySuccess) ? '1' : '0',
    bb.previewOk ? '1' : '0',
    String(probs.length),
    String(((ctx && ctx.filesTouched) || []).length),
    String(((ctx && ctx.todos) || []).filter((t) => t && t.status !== 'done').length),
  ].join('|');
}

/**
 * If ambient context changed since last admit, return a mid-conversation update
 * message; otherwise null. Updates ctx._systemContextFp.
 */
function admitContextUpdate(ctx, opts) {
  if (!ctx) return null;
  const fp = contextFingerprint(ctx);
  if (ctx._systemContextFp === fp) return null;
  const first = !ctx._systemContextFp;
  ctx._systemContextFp = fp;
  if (first && !(opts && opts.force)) {
    // Baseline already in first-turn pack — only emit on later changes
    return null;
  }
  const bb = ctx.blackboard || {};
  const lines = [
    '<system-reminder>',
    'Context update (ambient state changed — treat as current truth):',
    'cwd=' + (ctx.cwd || '/home/user'),
    'active_project=' + (ctx.activeProject || '(none)'),
    'phase=' + (bb.phase || '(none)') + ' owner=' + (bb.phaseOwner || '?'),
    'deliverySuccess=' + !!ctx.deliverySuccess,
    'previewOk=' + !!bb.previewOk,
    'open_todos=' +
      ((ctx.todos || []).filter((t) => t && t.status !== 'done').length || 0),
    'files_touched=' + ((ctx.filesTouched || []).slice(-8).join(', ') || '(none)'),
    '</system-reminder>',
  ];
  return lines.join('\n');
}

/**
 * Structured Work State skeleton for compaction (OpenCode-style).
 */
function workStateCompactionUser(goal, transcript, runState) {
  const rs = runState || {};
  return (
    'Goal: ' +
    String(goal || '').slice(0, 400) +
    '\n\nKnown run state (preserve these facts):\n' +
    '- Phase: ' +
    String(rs.phase || '') +
    '\n- Done when: ' +
    String(rs.doneWhen || '').slice(0, 300) +
    '\n- Files touched: ' +
    ((rs.filesTouched || []).slice(-20).join(', ') || '(none)') +
    '\n- Open todos: ' +
    ((rs.openTodos || []).slice(0, 12).map((t) => t.id + ':' + t.content).join('; ') ||
      '(none)') +
    '\n- Failures: ' +
    ((rs.failures || []).slice(-5).join('; ') || '(none)') +
    '\n- Delivery success: ' +
    !!rs.deliverySuccess +
    '\n\nOutput EXACTLY this structure:\n' +
    '## Objective\n' +
    '## Important Details\n' +
    '## Work State\n' +
    '### Completed\n' +
    '### Active\n' +
    '### Blocked\n' +
    '## Next Move\n' +
    '## Relevant Files\n\n' +
    'Transcript:\n' +
    String(transcript || '').slice(0, 12000)
  );
}

function maxStepsPrompt(doneWhen) {
  return (
    MAX_STEPS_PROMPT +
    (doneWhen
      ? '\n\ndone_when checklist:\n' + String(doneWhen).slice(0, 500)
      : '')
  );
}

module.exports = {
  MAX_STEPS_PROMPT,
  maxStepsPrompt,
  toolCallFingerprint,
  detectDoomLoop,
  detectRepeatedToolFails,
  pushDoomFingerprint,
  formatStatusSnapshot,
  formatSkillCatalog,
  findNearestAgentsMd,
  contextFingerprint,
  admitContextUpdate,
  workStateCompactionUser,
};
