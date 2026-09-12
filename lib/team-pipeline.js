'use strict';

/**
 * Team pipeline — fixed cast + phase machine on the blackboard.
 *
 * intake → research → strategy → plan → execute ↔ monitor → verify → done
 */

const { ensureParentDirs } = require('./paths');
const Agents = require('./agents');

const PHASES = [
  'intake',
  'research',
  'strategy',
  'plan',
  'execute',
  'monitor',
  'verify',
  'done',
];

const PHASE_OWNERS = {
  intake: 'intake',
  research: 'research',
  strategy: 'strategy',
  plan: 'plan',
  execute: 'build',
  monitor: 'monitor',
  verify: 'verify',
  done: 'orchestrator',
};

function phaseIndex(name) {
  const i = PHASES.indexOf(String(name || '').toLowerCase());
  return i < 0 ? 0 : i;
}

function nextPhase(name) {
  const i = phaseIndex(name);
  return PHASES[Math.min(i + 1, PHASES.length - 1)];
}

function setPhase(bb, phase, note) {
  if (!bb) return null;
  const p = String(phase || 'intake').toLowerCase();
  const prev = bb.phase || null;
  bb.phase = PHASES.indexOf(p) >= 0 ? p : 'intake';
  bb.phaseOwner = PHASE_OWNERS[bb.phase] || 'orchestrator';
  bb.phaseUpdatedAt = new Date().toISOString();
  if (!Array.isArray(bb.phaseLog)) bb.phaseLog = [];
  bb.phaseLog.push({
    from: prev,
    to: bb.phase,
    note: String(note || '').slice(0, 240),
    at: bb.phaseUpdatedAt,
  });
  bb.phaseLog = bb.phaseLog.slice(-24);
  return bb.phase;
}

function advancePhase(bb, note) {
  if (!bb) return null;
  return setPhase(bb, nextPhase(bb.phase), note || 'advance');
}

function buildIntake(briefing, userMessage) {
  const b = briefing || {};
  const skills = Array.isArray(b.skills) ? b.skills.slice() : [];
  const tools = Array.isArray(b.tools_priority)
    ? b.tools_priority.slice()
    : Array.isArray(b.tools)
      ? b.tools.slice()
      : [];
  return {
    request: String(userMessage || '').slice(0, 2000),
    goal: String(b.goal || '').slice(0, 800),
    taskType: String(b.task_type || 'mixed'),
    doneWhen: String(b.done_when || '').slice(0, 600),
    successCriteria: Array.isArray(b.success_criteria)
      ? b.success_criteria.map(String).slice(0, 12)
      : [],
    constraints: Array.isArray(b.constraints)
      ? b.constraints.map(String).slice(0, 12)
      : [],
    skillsNeeded: skills.slice(0, 12),
    toolsNeeded: tools.slice(0, 16),
    needsResearch:
      ['build', 'debug', 'research', 'mixed', 'git'].indexOf(
        String(b.task_type || '').toLowerCase(),
      ) >= 0,
    needsStrategy:
      ['build', 'debug', 'document', 'mixed', 'git', 'research'].indexOf(
        String(b.task_type || '').toLowerCase(),
      ) >= 0,
    needsPlan:
      ['build', 'debug', 'mixed', 'git'].indexOf(
        String(b.task_type || '').toLowerCase(),
      ) >= 0,
    needsVerify:
      ['build', 'debug'].indexOf(String(b.task_type || '').toLowerCase()) >= 0,
    at: new Date().toISOString(),
  };
}

function defaultStrategyPath(slug) {
  const safe =
    String(slug || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'task';
  return '/home/user/documents/plans/' + safe + '-STRATEGY.md';
}

function renderStrategyMarkdown(strategy) {
  const s = strategy || {};
  const lines = [
    '# Strategy',
    '',
    '## Goal',
    String(s.goal || '(unset)'),
    '',
    '## Approach',
    String(s.approach || 'Research → plan → specialist execute → verify.'),
    '',
    '## Cast',
    '- Intake: capture request + success criteria',
    '- Research: read-only map of workspace / web facts',
    '- Strategy: this artifact (risks, non-goals, specialist decision)',
    '- Plan: concrete steps + files (PLAN.md)',
    '- Execute: build orchestrator + optional custom specialist',
    '- Monitor: correct drift vs plan/todos',
    '- Verify: preview_project / verify_project before done',
    '',
    '## Skills',
  ];
  (s.skillsNeeded || []).forEach((x) => lines.push('- ' + x));
  if (!(s.skillsNeeded || []).length) lines.push('- (from briefing)');
  lines.push('', '## Tools');
  (s.toolsNeeded || []).forEach((x) => lines.push('- ' + x));
  if (!(s.toolsNeeded || []).length) lines.push('- write_file, preview_project, …');
  lines.push('', '## Research brief');
  lines.push(String(s.researchBrief || 'Explore relevant project paths before writing.'));
  lines.push('', '## Risks');
  (s.risks || ['Scope creep', 'Empty or partial file writes']).forEach((r) =>
    lines.push('- ' + r),
  );
  lines.push('', '## Out of scope');
  (s.outOfScope || ['Unrelated refactors']).forEach((r) => lines.push('- ' + r));
  lines.push('', '## Specialist');
  if (s.mintSpecialist) {
    lines.push(
      '- Mint custom agent `' +
        (s.specialistId || 'task-specialist') +
        '`: ' +
        (s.specialistWhy || 'Domain specialty beyond stock cast'),
    );
  } else {
    lines.push('- Use stock cast (build + explore + verify); no custom agent');
  }
  lines.push(
    '',
    '## Contract',
    '- Only one writer of workspace files at a time (execute specialist / build).',
    '- Research and monitor must not mutate project code.',
    '- Verify owns proof; no done claim without preview/verify when required.',
    '',
  );
  return lines.join('\n');
}

function buildStrategy(intake, opts) {
  const o = opts || {};
  const mint = shouldMintSpecialist(intake, o);
  return {
    goal: (intake && intake.goal) || '',
    approach:
      'Follow team phases. Research feeds plan. Execute against approved plan. Monitor mid-run. Verify before done.',
    skillsNeeded: (intake && intake.skillsNeeded) || [],
    toolsNeeded: (intake && intake.toolsNeeded) || [],
    researchBrief:
      'Map /home/user/projects and AGENTS.md; gather facts the plan must not invent.',
    risks: ['Writing outside active project', 'Claiming done without verify'],
    outOfScope: ['Unrelated features', 'Re-planning after approval'],
    mintSpecialist: mint.mint,
    specialistId: mint.id,
    specialistWhy: mint.why,
    specialistDescription: mint.description,
  };
}

function shouldMintSpecialist(intake, opts) {
  const o = opts || {};
  const text = (
    String((intake && intake.request) || '') +
    ' ' +
    String((intake && intake.goal) || '')
  ).toLowerCase();
  const task = String((intake && intake.taskType) || '').toLowerCase();

  const rules = [
    {
      id: 'pdf-doc-specialist',
      re: /\b(pdf|invoice|contract|resume|report)\b/,
      tasks: ['document', 'mixed'],
      why: 'Document/PDF delivery specialty',
      description:
        'Specialist for high-quality document and PDF creation in the workspace. Prefer create_pdf/create_document/write_file under /home/user/documents. Never claim done without a real file path.',
    },
    {
      id: 'web-app-specialist',
      re: /\b(game|canvas|three\.?js|websocket|pwa|spa|dashboard|landing\s*page)\b/,
      tasks: ['build', 'debug', 'mixed'],
      why: 'Interactive web/app specialty',
      description:
        'Specialist for HTML/CSS/JS (or light Node) apps under /home/user/projects/<slug>/. Write complete files, keep AGENTS.md updated, end with preview_project ok.',
    },
    {
      id: 'data-pipeline-specialist',
      re: /\b(csv|dataframe|etl|scrape|dataset|pandas|sql)\b/,
      tasks: ['build', 'research', 'mixed'],
      why: 'Data/ETL specialty',
      description:
        'Specialist for data transforms, CSV/JSON pipelines, and analysis scripts. Prefer write_file + run_python/run_javascript; verify outputs exist.',
    },
    {
      id: 'devops-git-specialist',
      re: /\b(docker|ci\/cd|github\s*actions|deploy|terraform)\b/,
      tasks: ['build', 'git', 'mixed'],
      why: 'DevOps/git specialty',
      description:
        'Specialist for repo layout, scripts, and git hygiene in the workspace. Prefer write_file for configs; use git_* tools for commits.',
    },
  ];

  if (o.forceMint && o.forceId) {
    return {
      mint: true,
      id: o.forceId,
      why: o.forceWhy || 'Requested',
      description: o.forceDescription || 'Custom task specialist',
    };
  }

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (
      r.re.test(text) &&
      (!r.tasks.length || r.tasks.indexOf(task) >= 0 || task === 'mixed')
    ) {
      return {
        mint: true,
        id: r.id,
        why: r.why,
        description: r.description,
      };
    }
  }

  const todos =
    o.todoCount != null
      ? o.todoCount
      : (intake && intake.successCriteria && intake.successCriteria.length) || 0;
  if (task === 'build' && todos >= 5) {
    return {
      mint: true,
      id: 'feature-build-specialist',
      why: 'Multi-step feature build benefits from a focused specialist',
      description:
        'Focused feature builder. Implement only the approved plan under the active project. Coordinate with verify via preview_project. No scope expansion.',
    };
  }

  return { mint: false, id: null, why: '', description: '' };
}

function writeStrategyArtifact(ctx, strategy, path) {
  const files = (ctx && ctx.files) || {};
  const p =
    path ||
    defaultStrategyPath(
      (ctx && ctx.activeProject) ||
        (strategy && strategy.specialistId) ||
        'task',
    );
  ensureParentDirs(files, p);
  const content = renderStrategyMarkdown(strategy);
  files[p] = {
    path: p,
    type: 'file',
    content: content,
    encoding: 'utf8',
  };
  if (ctx) {
    ctx.files = files;
    if (ctx.blackboard) {
      ctx.blackboard.strategyPath = p;
      ctx.blackboard.strategy = strategy;
    }
  }
  return { path: p, content: content };
}

function applyIntakeToBlackboard(bb, intake) {
  if (!bb || !intake) return bb;
  bb.intake = intake;
  bb.goal = intake.goal || bb.goal;
  bb.doneWhen = intake.doneWhen || bb.doneWhen;
  bb.skillsNeeded = intake.skillsNeeded || [];
  bb.toolsNeeded = intake.toolsNeeded || [];
  return bb;
}

function monitorCheck(ctx, opts) {
  const o = opts || {};
  const bb = (ctx && ctx.blackboard) || {};
  const gaps = [];
  const phase = bb.phase || 'execute';
  const intake = bb.intake || {};
  const task = String(
    (ctx && ctx.taskType) || intake.taskType || '',
  ).toLowerCase();

  if (ctx && ctx.lockActiveProject && ctx.activeProject) {
    const root = '/home/user/projects/' + ctx.activeProject;
    const bad = (ctx.filesTouched || []).filter(
      (p) =>
        String(p).indexOf('/home/user/projects/') === 0 &&
        String(p).indexOf(root) !== 0,
    );
    if (bad.length) {
      gaps.push(
        'Wrote outside locked project ' +
          ctx.activeProject +
          ': ' +
          bad.slice(-3).join(', '),
      );
    }
  }

  if (bb.requirePlan && !bb.planPath && phaseIndex(phase) >= phaseIndex('execute')) {
    gaps.push('Execute started without plan artifact path');
  }

  if (
    intake.needsResearch &&
    phaseIndex(phase) >= phaseIndex('execute') &&
    !(bb.findings || []).length &&
    !(bb.delegates || []).some(
      (d) => d.agent === 'explore' || d.agent === 'research',
    ) &&
    (ctx.filesTouched || []).length === 0 &&
    o.toolsUsed > 2
  ) {
    gaps.push('No research findings before heavy execute — map the tree first');
  }

  if (
    intake.needsVerify &&
    (o.nearDone || phase === 'verify') &&
    !(ctx && ctx.previewOk)
  ) {
    gaps.push('preview_project not ok — verify before claiming done');
  }

  if (
    (task === 'build' || task === 'document') &&
    o.toolsUsed > 3 &&
    !(ctx && ctx.deliverySuccess) &&
    !(ctx.filesTouched || []).length
  ) {
    gaps.push('No workspace files delivered yet');
  }

  if (
    bb.specialist &&
    bb.specialist.name &&
    o.toolsUsed > 4 &&
    !(bb.delegates || []).some(
      (d) =>
        d.agent === bb.specialist.name || d.agent === bb.specialist.identifier,
    ) &&
    phase === 'execute'
  ) {
    gaps.push(
      'Custom specialist `' +
        bb.specialist.name +
        '` was minted but unused — delegate_task to it for implement slices',
    );
  }

  const ok = gaps.length === 0;
  return {
    pass: ok,
    score: ok ? 100 : Math.max(20, 90 - gaps.length * 15),
    gaps: gaps,
    fix_brief: ok
      ? ''
      : 'MONITOR: ' +
        gaps.slice(0, 4).join('; ') +
        '. Correct course, then continue. Do not re-plan unless plan is wrong.',
    role: 'monitor',
    phase: phase,
  };
}

function formatTeamPrompt(bb, opts) {
  const o = opts || {};
  if (!bb) return '';
  const lines = [
    '# Team pipeline (mandatory)',
    'Phases: ' + PHASES.join(' → '),
    'Current phase: **' +
      (bb.phase || 'intake') +
      '** (owner: ' +
      (bb.phaseOwner || '?') +
      ')',
  ];
  if (bb.intake) {
    lines.push(
      'Intake goal: ' + (bb.intake.goal || ''),
      'Skills: ' +
        ((bb.skillsNeeded || bb.intake.skillsNeeded || []).join(', ') ||
          '(none)'),
      'Tools priority: ' +
        ((bb.toolsNeeded || bb.intake.toolsNeeded || []).join(', ') || '(none)'),
    );
  }
  if (bb.strategyPath) lines.push('Strategy artifact: `' + bb.strategyPath + '`');
  if (bb.planPath) {
    lines.push(
      'Plan artifact: `' +
        bb.planPath +
        '`' +
        (bb.planApproved ? ' (approved)' : ''),
    );
  }
  if (bb.specialist && bb.specialist.name) {
    lines.push(
      'Custom specialist: `' +
        bb.specialist.name +
        '` — ' +
        (bb.specialist.whenToUse || bb.specialist.why || 'use via delegate_task'),
    );
  }
  lines.push(
    '',
    'Rules:',
    '- Research (explore/research) is read-only and feeds plan/strategy.',
    '- Do not skip verify on build/debug.',
    '- Monitor corrections override narration — follow fix briefs.',
    '- One workspace writer at a time; prefer active project root.',
  );
  if (o.extra) lines.push(String(o.extra));
  return lines.join('\n');
}

function phaseEvent(phase, text, extra) {
  return Object.assign(
    {
      type: 'phase',
      phase: phase,
      text: text || phaseLabel(phase),
      team: true,
    },
    extra || {},
  );
}

function phaseLabel(phase) {
  const map = {
    intake: 'Intake — reading the request',
    research: 'Research — gathering facts',
    strategy: 'Strategy — choosing approach',
    plan: 'Plan — steps, tools, skills',
    execute: 'Execute — building in the workspace',
    monitor: 'Monitor — checking team course',
    verify: 'Verify — proving it works',
    done: 'Done',
  };
  return map[phase] || phase;
}

async function bootstrapTeam({
  ctx,
  briefing,
  userMessage,
  emit,
  model,
  userId,
  generateCustomAgent,
  skipPhases,
}) {
  if (!ctx || !ctx.blackboard) return { skipped: true };
  if (skipPhases) {
    setPhase(ctx.blackboard, 'execute', 'light task');
    return { skipped: true, phase: 'execute' };
  }

  const intake = buildIntake(briefing, userMessage);
  applyIntakeToBlackboard(ctx.blackboard, intake);
  setPhase(ctx.blackboard, 'intake', 'captured request');
  if (typeof emit === 'function') {
    emit(phaseEvent('intake', phaseLabel('intake'), { intake: intake }));
  }

  if (intake.needsResearch) {
    setPhase(ctx.blackboard, 'research', 'research required');
    if (typeof emit === 'function') {
      emit(
        phaseEvent(
          'research',
          'Research — map workspace / facts before inventing paths',
        ),
      );
    }
  }

  const strategy = buildStrategy(intake, {
    todoCount: Array.isArray(briefing && briefing.todos)
      ? briefing.todos.length
      : 0,
  });
  setPhase(ctx.blackboard, 'strategy', 'strategy drafted');
  const artifact = writeStrategyArtifact(ctx, strategy);
  if (typeof emit === 'function') {
    emit(
      phaseEvent('strategy', phaseLabel('strategy'), {
        strategyPath: artifact.path,
        mintSpecialist: !!strategy.mintSpecialist,
      }),
    );
  }

  let specialist = null;
  if (strategy.mintSpecialist && typeof generateCustomAgent === 'function') {
    try {
      specialist = await generateCustomAgent({
        description:
          strategy.specialistDescription ||
          strategy.specialistWhy ||
          intake.goal,
        model: model,
        userId: userId,
        existingNames: (ctx.customAgents || []).map(
          (a) => a.name || a.identifier,
        ),
        workspaceHint:
          'Active project: ' +
          (ctx.activeProject || '(none)') +
          '\nGoal: ' +
          intake.goal +
          '\nTask: ' +
          intake.taskType,
      });
      if (strategy.specialistId && specialist) {
        const taken = (ctx.customAgents || []).some(
          (a) => a.name === strategy.specialistId,
        );
        if (!taken && !Agents.getNative(strategy.specialistId)) {
          specialist.name = strategy.specialistId;
          specialist.identifier = strategy.specialistId;
        }
      }
      specialist.whenToUse =
        specialist.whenToUse ||
        'Use this agent when implementing: ' + (intake.goal || 'the current task');
      specialist.why = strategy.specialistWhy;
      ctx.customAgents = (ctx.customAgents || []).concat([specialist]);
      ctx.blackboard.specialist = {
        name: specialist.name,
        identifier: specialist.identifier,
        whenToUse: specialist.whenToUse,
        why: strategy.specialistWhy,
      };
      if (typeof emit === 'function') {
        emit({
          type: 'agent',
          name: specialist.name,
          mode: 'specialist',
          description: specialist.whenToUse || specialist.description || '',
          native: false,
          minted: true,
          team: true,
        });
        emit({
          type: 'team',
          event: 'specialist_minted',
          specialist: ctx.blackboard.specialist,
        });
      }
    } catch (e) {
      if (typeof emit === 'function') {
        emit({
          type: 'team',
          event: 'specialist_mint_failed',
          error: (e && e.message) || String(e),
        });
      }
    }
  }

  if (intake.needsPlan && !ctx.planApproved) {
    setPhase(ctx.blackboard, 'plan', 'awaiting / writing plan');
    if (typeof emit === 'function') {
      emit(phaseEvent('plan', phaseLabel('plan')));
    }
  } else {
    setPhase(ctx.blackboard, 'execute', 'ready to execute');
    if (typeof emit === 'function') {
      emit(phaseEvent('execute', phaseLabel('execute')));
    }
  }

  return {
    skipped: false,
    phase: ctx.blackboard.phase,
    intake: intake,
    strategy: strategy,
    strategyPath: artifact.path,
    specialist: specialist,
  };
}

function shouldRunMonitor(ctx, toolsUsed, lastMonitorAt) {
  if (!ctx || !ctx.blackboard) return false;
  const phase = ctx.blackboard.phase || '';
  if (phase === 'done' || phase === 'intake') return false;
  if (toolsUsed > 0 && toolsUsed % 3 === 0 && toolsUsed !== lastMonitorAt) {
    return true;
  }
  return false;
}

module.exports = {
  PHASES: PHASES,
  PHASE_OWNERS: PHASE_OWNERS,
  phaseIndex: phaseIndex,
  nextPhase: nextPhase,
  setPhase: setPhase,
  advancePhase: advancePhase,
  buildIntake: buildIntake,
  buildStrategy: buildStrategy,
  shouldMintSpecialist: shouldMintSpecialist,
  defaultStrategyPath: defaultStrategyPath,
  renderStrategyMarkdown: renderStrategyMarkdown,
  writeStrategyArtifact: writeStrategyArtifact,
  applyIntakeToBlackboard: applyIntakeToBlackboard,
  monitorCheck: monitorCheck,
  formatTeamPrompt: formatTeamPrompt,
  phaseEvent: phaseEvent,
  phaseLabel: phaseLabel,
  bootstrapTeam: bootstrapTeam,
  shouldRunMonitor: shouldRunMonitor,
};
