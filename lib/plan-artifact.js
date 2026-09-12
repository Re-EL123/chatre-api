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
  md +=
    '\n## Contract\n' +
    '- Build must not re-plan; execute this artifact.\n' +
    '- Verify owns preview_project before claiming done.\n';
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

  return {
    goal: (sections.goal || '').split('\n')[0] || '',
    doneWhen: (sections.doneWhen || '').split('\n')[0] || '',
    steps: bulletLines(sections.steps),
    files: bulletLines(sections.files),
    risks: bulletLines(sections.risks),
    outOfScope: bulletLines(sections.outOfScope),
    todos: bulletLines(sections.todos).map((c, i) => {
      const m = c.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (m) return { id: 'pt' + (i + 1), content: m[2], owner: m[1].toLowerCase() };
      return { id: 'pt' + (i + 1), content: c, owner: 'build' };
    }),
    raw,
    complete: !!(sections.goal && sections.doneWhen && sections.steps),
  };
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

function ensureFromBriefing(ctx, briefing, userMessage) {
  const existing = findExistingPlan(ctx.files);
  if (existing && existing.content && existing.content.length > 40) {
    ctx.planPath = existing.path;
    return {
      path: existing.path,
      content: existing.content,
      parsed: parsePlanArtifact(existing.content),
      existed: true,
    };
  }
  const b = briefing || {};
  const steps =
    (Array.isArray(b.approach) && b.approach) ||
    (Array.isArray(b.todos) &&
      b.todos.map((t) => (typeof t === 'string' ? t : t.content))) ||
    [];
  const written = writePlanToFiles(ctx, {
    goal: b.goal || String(userMessage || '').slice(0, 200),
    doneWhen: b.done_when || (ctx && ctx.doneWhen) || '',
    steps,
    files: b.files || [],
    risks: b.risks || [],
    outOfScope: b.out_of_scope || [],
    todos: b.todos || [],
  });
  return Object.assign({ existed: false }, written);
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
  writePlanToFiles,
  ensureFromBriefing,
  handoffPrompt,
  missingPlanNudge,
  planPromptExtra,
};
