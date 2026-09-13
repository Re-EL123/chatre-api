'use strict';

/**
 * Multi-role critique: verify bar + plan adherence.
 */

const CRITIC_PROMPT = `You are Chatre's critic (quality + plan adherence). Decide if the team finished the user's request satisfactorily — not merely whether some file exists.

Fail (pass=false) when:
- Acceptance / Done when is not evidenced in tools or workspace
- Deliverable is a chat tutorial / HTML dump without real write_file (or create_pdf/document) success
- Build/game/app/website lacks working preview_project when required
- Document/PDF/spreadsheet request has no matching artifact under /home/user/documents (or csv path)
- Obvious UX/spec gaps vs the user request (broken calculator, empty doc, placeholder-only site)

Pass only when a reasonable user would not need to re-prompt for basic fixes.

Output ONLY JSON:
{
  "pass": true|false,
  "score": 0-100,
  "gaps": ["what is missing or wrong"],
  "fix_brief": "If pass=false, short orders for the build orchestrator. Empty if pass=true.",
  "role": "plan"
}

Be strict about success criteria and the plan's Done when. Do not invent requirements.
You are Chatre — never mention other products.`;

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* continue */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* continue */
    }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeCritique(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  return {
    pass: o.pass === true,
    score: Math.max(0, Math.min(100, Number(o.score) || 0)),
    gaps: Array.isArray(o.gaps) ? o.gaps.map(String) : [],
    fix_brief: String(o.fix_brief || o.fixBrief || '').trim(),
    role: String(o.role || 'plan'),
  };
}

function criticUserPrompt({
  userMessage,
  briefing,
  answer,
  toolSummary,
  planText,
  blackboardText,
}) {
  return (
    'User request:\n' +
    String(userMessage || '').trim() +
    '\n\nPlan goal: ' +
    String((briefing && briefing.goal) || '') +
    '\nTask type: ' +
    String((briefing && briefing.task_type) || '') +
    '\nSuccess criteria:\n' +
    ((briefing && briefing.success_criteria) || [])
      .map((c, i) => i + 1 + '. ' + c)
      .join('\n') +
    '\nAcceptance tests:\n' +
    ((briefing && briefing.acceptance_tests) || [])
      .map((c, i) => i + 1 + '. ' + c)
      .join('\n') +
    '\nDone when: ' +
    String((briefing && briefing.done_when) || '') +
    '\n\nApproved plan artifact:\n' +
    String(planText || '(none)').slice(0, 6000) +
    '\n\nBlackboard:\n' +
    String(blackboardText || '(none)').slice(0, 3000) +
    '\n\nExecutor answer:\n' +
    String(answer || '').slice(0, 8000) +
    '\n\nTool summary:\n' +
    String(toolSummary || '(none)').slice(0, 4000)
  );
}

/**
 * Deterministic verify-role gate (no LLM).
 */
function verifyRoleCritique(ctx, taskType) {
  const kind = String(taskType || (ctx && ctx.taskType) || '').toLowerCase();
  const needsPreview = kind === 'build' || kind === 'debug';
  if (!needsPreview) {
    return { pass: true, score: 100, gaps: [], fix_brief: '', role: 'verify' };
  }
  if (ctx && ctx.previewOk) {
    return { pass: true, score: 100, gaps: [], fix_brief: '', role: 'verify' };
  }
  const errors =
    (ctx &&
      ctx.blackboard &&
      Array.isArray(ctx.blackboard.previewErrors) &&
      ctx.blackboard.previewErrors) ||
    [];
  const gaps = ['preview_project not ok'];
  if (errors.length) {
    errors.slice(0, 6).forEach((e) => gaps.push(String(e)));
  }
  return {
    pass: false,
    score: 30,
    gaps,
    fix_brief:
      'VERIFY FAIL: Call preview_project on the project path (or delegate_task agent=verify). ' +
      'Fix reported errors with patch_file/write_file, re-preview until ok. Do not claim done yet.',
    role: 'verify',
  };
}

/**
 * Merge verify + plan critiques; prefer failing verify first.
 */
function mergeCritiques(verifyC, planC) {
  if (verifyC && !verifyC.pass) {
    return {
      pass: false,
      score: Math.min(verifyC.score || 0, (planC && planC.score) || 100),
      gaps: (verifyC.gaps || []).concat((planC && planC.gaps) || []).slice(0, 20),
      fix_brief: verifyC.fix_brief || (planC && planC.fix_brief) || '',
      role: 'verify',
      parts: { verify: verifyC, plan: planC },
    };
  }
  if (planC && !planC.pass) {
    return Object.assign({}, planC, {
      role: 'plan',
      parts: { verify: verifyC, plan: planC },
    });
  }
  return {
    pass: true,
    score: Math.min(
      (verifyC && verifyC.score) || 100,
      (planC && planC.score) || 100,
    ),
    gaps: [],
    fix_brief: '',
    role: 'merged',
    parts: { verify: verifyC, plan: planC },
  };
}

module.exports = {
  CRITIC_PROMPT,
  extractJsonObject,
  normalizeCritique,
  criticUserPrompt,
  verifyRoleCritique,
  mergeCritiques,
};
