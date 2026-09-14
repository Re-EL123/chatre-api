'use strict';

/**
 * Structured plan artifact contract for plan → build handoff.
 */

const { ensureParentDirs } = require('./paths');

const PLAN_DIR = '/home/user/documents/plans';
const SECTION_RE = {
  goal: /^##\s*Goal\b/im,
  doneWhen: /^##\s*Done when\b/im,
  steps: /^##\s*(Steps|Tasks|Implementation)\b/im,
  files: /^##\s*(Files|File list|Deliverables)\b/im,
  risks: /^##\s*Risks\b/im,
  outOfScope: /^##\s*(Out of scope|Non-goals)\b/im,
  acceptance: /^##\s*(Acceptance|Acceptance tests|Success criteria)\b/im,
};

function defaultPlanPath(slug) {
  const safe = String(slug || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return PLAN_DIR + '/' + safe + '-PLAN.md';
}

function projectPlanPath(projectSlug) {
  if (!projectSlug) return null;
  return '/home/user/projects/' + projectSlug + '/PLAN.md';
}

function findExistingPlan(files) {
  const keys = Object.keys(files || {}).filter((p) => {
    if (!files[p] || files[p].type !== 'file') return false;
    return (
      /\/PLAN\.md$/i.test(p) ||
      /\/plan\.md$/i.test(p) ||
      /\/documents\/plans\/.+\.md$/i.test(p)
    );
  });
  if (!keys.length) return null;
  keys.sort();
  const path = keys[keys.length - 1];
  return { path, content: String(files[path].content || '') };
}

function renderPlanMarkdown(plan) {
  const p = plan || {};
  const steps = Array.isArray(p.steps)
    ? p.steps
    : String(p.steps || '')
        .split('\n')
        .map((s) => s.replace(/^[-*\d.)\s]+/, '').trim())
        .filter(Boolean);
  const files = Array.isArray(p.files) ? p.files : [];
  const risks = Array.isArray(p.risks) ? p.risks : [];
  const outOfScope = Array.isArray(p.outOfScope) ? p.outOfScope : [];
  const todos = Array.isArray(p.todos) ? p.todos : [];
  const acceptance = Array.isArray(p.acceptance)
    ? p.acceptance
    : Array.isArray(p.acceptance_tests)
      ? p.acceptance_tests
      : Array.isArray(p.success_criteria)
        ? p.success_criteria
        : [];

  let md = '# Plan\n\n';
  md += '## Goal\n' + String(p.goal || '(unset)') + '\n\n';
  md += '## Done when\n' + String(p.doneWhen || p.done_when || '(unset)') + '\n\n';
  md += '## Steps\n';
  if (steps.length) {
    steps.forEach((s, i) => {
      md += i + 1 + '. ' + s + '\n';
    });
  } else {
    md += '1. Explore relevant paths\n2. Implement deliverables\n3. Verify with preview_project\n';
  }
  md += '\n## Files\n';
  if (files.length) {
    files.forEach((f) => {
      md += '- ' + f + '\n';
    });
  } else {
    md += '- (list paths the build must create or edit)\n';
  }
  md += '\n## Risks\n';
  if (risks.length) {
    risks.forEach((r) => {
      md += '- ' + r + '\n';
    });
  } else {
    md += '- (none listed)\n';
  }
  md += '\n## Out of scope\n';
  if (outOfScope.length) {
    outOfScope.forEach((r) => {
      md += '- ' + r + '\n';
    });
  } else {
    md += '- (none)\n';
  }
  if (todos.length) {
    md += '\n## Todos\n';
    todos.forEach((t) => {
      const c = typeof t === 'string' ? t : t.content || '';
      const owner = typeof t === 'object' && t.owner ? t.owner : 'build';
      md += '- [' + owner + '] ' + c + '\n';
    });
  }
  md += '\n## Acceptance tests\n';
  if (acceptance.length) {
    acceptance.forEach((a) => {
      const c = typeof a === 'string' ? a : a.text || a.content || '';
      if (c) md += '- ' + c + '\n';
    });
  } else {
    md += '- (define measurable checks: files exist, preview ok, …)\n';
  }
  md +=
    '\n## Contract\n' +
    '- Build must not re-plan; execute this artifact.\n' +
    '- Verify owns preview_project before claiming done.\n' +
    '- All Acceptance tests must pass before done.\n';
  return md;
}

function parsePlanArtifact(content) {
  const raw = String(content || '');
  const sections = {};
  const lines = raw.split('\n');
  let current = null;
  const buf = {};
  lines.forEach((line) => {
    let matched = null;
    Object.keys(SECTION_RE).forEach((k) => {
      if (SECTION_RE[k].test(line)) matched = k;
    });
    if (/^##\s*Todos\b/im.test(line)) matched = 'todos';
    if (matched) {
      current = matched;
      buf[current] = buf[current] || [];
      return;
    }
    if (current) buf[current].push(line);
  });
  Object.keys(buf).forEach((k) => {
    sections[k] = buf[k].join('\n').trim();
  });
  const bulletLines = (text) =>
    String(text || '')
      .split('\n')
      .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter((l) => l && !/^\(/.test(l));

  const goal = (sections.goal || '').split('\n')[0] || '';
  const doneWhen = (sections.doneWhen || '').split('\n')[0] || '';
  const steps = bulletLines(sections.steps);
  const files = bulletLines(sections.files);
  const acceptance = bulletLines(sections.acceptance);
  const parsed = {
    goal,
    doneWhen,
    steps,
    files,
    risks: bulletLines(sections.risks),
    outOfScope: bulletLines(sections.outOfScope),
    todos: bulletLines(sections.todos).map((c, i) => {
      const m = c.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (m) return { id: 'pt' + (i + 1), content: m[2], owner: m[1].toLowerCase() };
      return { id: 'pt' + (i + 1), content: c, owner: 'build' };
    }),
    acceptance,
    raw,
    complete: false,
    errors: [],
  };
  parsed.errors = planStructureErrors(parsed);
  parsed.complete = parsed.errors.length === 0;
  return parsed;
}

function isPlaceholderLine(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return true;
  if (/^\(/.test(t)) return true;
  if (/^unset\b/.test(t)) return true;
  if (/list paths the build must/i.test(t)) return true;
  if (/define measurable/i.test(t)) return true;
  if (/none listed|none\)$/i.test(t)) return true;
  if (/^user-visible goal completed/.test(t)) return true;
  if (/^goal completed with workspace/.test(t)) return true;
  if (/^deliverables exist and match/.test(t)) return true;
  if (/^verify and summarize$/.test(t)) return true;
  if (/^implement the work$/.test(t)) return true;
  if (/^complete the (user )?request$/.test(t)) return true;
  try {
    const Understanding = require('./understanding');
    if (Understanding.isSoftDoneWhen(s)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function planStructureErrors(parsed) {
  const p = parsed || {};
  const errors = [];
  if (!p.goal || isPlaceholderLine(p.goal) || String(p.goal).length < 4) {
    errors.push('Goal must be a concrete sentence');
  }
  if (!p.doneWhen || isPlaceholderLine(p.doneWhen) || String(p.doneWhen).length < 4) {
    errors.push('Done when must be observable');
  }
  const steps = (p.steps || []).filter((s) => !isPlaceholderLine(s));
  if (steps.length < 2) {
    errors.push('Steps need at least 2 concrete items');
  }
  const files = (p.files || []).filter((s) => !isPlaceholderLine(s));
  if (files.length < 1) {
    errors.push('Files must list at least one path to create or edit');
  }
  const acceptance = (p.acceptance || []).filter((s) => !isPlaceholderLine(s));
  if (acceptance.length < 1) {
    errors.push('Acceptance tests need at least one measurable check');
  }
  return errors;
}

function isPlanComplete(parsedOrContent) {
  const parsed =
    parsedOrContent && typeof parsedOrContent === 'object' && parsedOrContent.raw != null
      ? parsedOrContent
      : parsePlanArtifact(parsedOrContent);
  return !!(parsed && parsed.complete);
}

function writePlanToFiles(ctx, plan, pathOpt) {
  const path =
    pathOpt ||
    projectPlanPath(ctx && ctx.activeProject) ||
    defaultPlanPath((ctx && ctx.activeProject) || 'task');
  const content = renderPlanMarkdown(plan);
  if (!ctx.files) ctx.files = {};
  ensureParentDirs(ctx.files, path);
  ctx.files[path] = { path, type: 'file', content };
  ctx.planPath = path;
  if (Array.isArray(ctx.filesTouched)) ctx.filesTouched.push(path);
  return { path, content, parsed: parsePlanArtifact(content) };
}

function briefingToPlanFields(briefing, userMessage, ctx) {
  const b = briefing || {};
  const steps =
    (Array.isArray(b.approach) && b.approach.length && b.approach) ||
    (Array.isArray(b.plan_steps) &&
      b.plan_steps.map((s) =>
        typeof s === 'string' ? s : (s && (s.text || s.content)) || '',
      )) ||
    (Array.isArray(b.todos) &&
      b.todos.map((t) => (typeof t === 'string' ? t : t.content))) ||
    [];
  return {
    goal: b.goal || String(userMessage || '').slice(0, 200),
    doneWhen:
      b.done_when ||
      b.doneWhen ||
      (ctx && ctx.doneWhen) ||
      (Array.isArray(b.success_criteria) && b.success_criteria[0]) ||
      '',
    steps: steps.filter(Boolean),
    files: Array.isArray(b.files) ? b.files : b.file_list || [],
    risks: b.risks || [],
    outOfScope: b.out_of_scope || b.outOfScope || [],
    todos: b.todos || [],
    acceptance:
      b.acceptance_tests ||
      b.acceptanceTests ||
      b.success_criteria ||
      [],
  };
}

/**
 * Create or load a plan artifact.
 * opts.forceRewrite — always rewrite from briefing (use on Approve).
 * opts.reuseOk — allow reusing existing file when complete (default true for pause).
 */
function ensureFromBriefing(ctx, briefing, userMessage, opts) {
  const o = opts || {};
  const force = o.forceRewrite === true;
  const reuseOk = o.reuseOk !== false && !force;
  const existing = findExistingPlan(ctx.files);

  if (reuseOk && existing && existing.content && existing.content.length > 40) {
    const parsed = parsePlanArtifact(existing.content);
    // Only reuse if structurally complete; otherwise rewrite from briefing.
    if (parsed.complete) {
      ctx.planPath = existing.path;
      return {
        path: existing.path,
        content: existing.content,
        parsed,
        existed: true,
      };
    }
  }

  const fields = briefingToPlanFields(briefing, userMessage, ctx);
  const pathOpt =
    (existing && existing.path) ||
    projectPlanPath(ctx && ctx.activeProject) ||
    defaultPlanPath((ctx && ctx.activeProject) || 'task');
  const written = writePlanToFiles(ctx, fields, pathOpt);
  return Object.assign({ existed: false, rewritten: force || !!(existing && existing.content) }, written);
}

function rewriteFromBriefing(ctx, briefing, userMessage) {
  return ensureFromBriefing(ctx, briefing, userMessage, {
    forceRewrite: true,
    reuseOk: false,
  });
}

function handoffPrompt(plan, blackboardText) {
  const p = plan && plan.parsed ? plan.parsed : plan || {};
  const path = (plan && plan.path) || '(plan)';
  return (
    '# Plan → Build handoff (approved)\n' +
    'You are now the **build** orchestrator. Do NOT re-plan. Execute the approved plan.\n\n' +
    'Plan file: ' +
    path +
    ' — read_file it if you need details.\n\n' +
    '## Goal\n' +
    (p.goal || '') +
    '\n\n## Done when\n' +
    (p.doneWhen || '') +
    '\n\n## Steps\n' +
    ((p.steps || []).map((s, i) => i + 1 + '. ' + s).join('\n') || '(see plan file)') +
    '\n\n## Team execute\n' +
    '1. Read STRATEGY.md if present; follow blackboard phase.\n' +
    '2. If research is thin, delegate_task(agent=explore|research).\n' +
    '3. If a custom specialist is on the blackboard, delegate_task(agent=<specialist>) for implement slices.\n' +
    '4. Else implement with write_file/patch_file (or delegate_task agent=general).\n' +
    '5. Parallelize only independent explore/read goals via goals[] on delegate_task.\n' +
    '6. Obey MONITOR fix briefs; one workspace writer at a time.\n' +
    '7. Hand verify to preview: preview_project (or delegate_task agent=verify).\n' +
    '8. Fix preview errors; do not claim done until preview ok.\n\n' +
    (blackboardText ? blackboardText + '\n\n' : '') +
    'Call tools now. Do not narrate file writes.'
  );
}

function missingPlanNudge(ctx) {
  if (!(ctx && ctx.requirePlan)) return null;
  if (ctx.planPath && ctx.files && ctx.files[ctx.planPath]) return null;
  const found = findExistingPlan(ctx.files);
  if (found) {
    ctx.planPath = found.path;
    return null;
  }
  return (
    '[internal] Build requires an approved plan artifact (PLAN.md or /home/user/documents/plans/*). ' +
    'If missing, write a short plan under /home/user/documents/plans/ then continue implementing. Do not narrate.'
  );
}

function planPromptExtra() {
  return (
    'When the plan is ready, write it with write_file to either:\n' +
    '- /home/user/documents/plans/<slug>-PLAN.md, or\n' +
    '- /home/user/projects/<slug>/PLAN.md\n\n' +
    'Required markdown sections:\n' +
    '- Goal, Done when, Steps, Files, Risks, Out of scope, Acceptance tests\n' +
    'Legacy note — still require:\n' +
    '## Goal\n## Done when\n## Steps\n## Files\n## Risks\n## Out of scope\n\n' +
    'Optional ## Todos with owners like `- [explore] …` / `- [build] …` / `- [verify] …`.\n' +
    'Then stop and wait for Approve & execute. Do not implement code.'
  );
}

module.exports = {
  PLAN_DIR,
  defaultPlanPath,
  projectPlanPath,
  findExistingPlan,
  renderPlanMarkdown,
  parsePlanArtifact,
  planStructureErrors,
  isPlanComplete,
  isPlaceholderLine,
  writePlanToFiles,
  briefingToPlanFields,
  ensureFromBriefing,
  rewriteFromBriefing,
  handoffPrompt,
  missingPlanNudge,
  planPromptExtra,
};
