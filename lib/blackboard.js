'use strict';

/**
 * Shared team blackboard — durable state parent + subagents can see.
 * Owners: explore | build | verify | general | plan | orchestrator
 */

function createBlackboard(seed) {
  const s = seed && typeof seed === 'object' ? seed : {};
  return {
    version: 2,
    goal: String(s.goal || ''),
    doneWhen: String(s.doneWhen || s.done_when || ''),
    planPath: s.planPath || s.plan_path || null,
    planApproved: !!s.planApproved,
    requirePlan: !!s.requirePlan,
    phase: s.phase || null,
    phaseOwner: s.phaseOwner || null,
    phaseUpdatedAt: s.phaseUpdatedAt || null,
    phaseLog: Array.isArray(s.phaseLog) ? s.phaseLog.slice(-24) : [],
    intake: s.intake && typeof s.intake === 'object' ? s.intake : null,
    intentContract: String(s.intentContract || s.intent_contract || ''),
    userCorrections: Array.isArray(s.userCorrections)
      ? s.userCorrections.map(String).slice(0, 16)
      : Array.isArray(s.user_corrections)
        ? s.user_corrections.map(String).slice(0, 16)
        : [],
    deliverableKind: s.deliverableKind || s.deliverable_kind || null,
    understandingConfidence:
      s.understandingConfidence != null
        ? Number(s.understandingConfidence)
        : s.confidence != null
          ? Number(s.confidence)
          : null,
    strategyPath: s.strategyPath || s.strategy_path || null,
    strategy: s.strategy && typeof s.strategy === 'object' ? s.strategy : null,
    skillsNeeded: Array.isArray(s.skillsNeeded) ? s.skillsNeeded.slice(0, 16) : [],
    toolsNeeded: Array.isArray(s.toolsNeeded) ? s.toolsNeeded.slice(0, 20) : [],
    specialist: s.specialist && typeof s.specialist === 'object' ? s.specialist : null,
    monitorNotes: Array.isArray(s.monitorNotes) ? s.monitorNotes.slice(-12) : [],
    todos: Array.isArray(s.todos) ? s.todos.map(normalizeTodo).filter(Boolean) : [],
    filesTouched: Array.isArray(s.filesTouched) ? s.filesTouched.slice() : [],
    findings: Array.isArray(s.findings) ? s.findings.slice(-40) : [],
    risks: Array.isArray(s.risks) ? s.risks.slice(-20) : [],
    nextActions: Array.isArray(s.nextActions) ? s.nextActions.slice(-20) : [],
    previewErrors: Array.isArray(s.previewErrors) ? s.previewErrors.slice(-30) : [],
    previewOk: !!s.previewOk,
    lastPreviewPath: s.lastPreviewPath || null,
    handoffs: Array.isArray(s.handoffs) ? s.handoffs.slice(-12) : [],
    delegates: Array.isArray(s.delegates) ? s.delegates.slice(-12) : [],
  };
}

function normalizeTodo(item, i) {
  if (typeof item === 'string') {
    return {
      id: 't' + ((i || 0) + 1),
      content: item,
      status: 'pending',
      owner: 'build',
      phase: 'implement',
    };
  }
  if (!item || typeof item !== 'object') return null;
  const status = String(item.status || 'pending').toLowerCase();
  return {
    id: String(item.id || 't' + ((i || 0) + 1)),
    content: String(item.content || item.text || item.title || ''),
    status:
      status === 'done' || status === 'completed'
        ? 'done'
        : status === 'in_progress'
          ? 'in_progress'
          : 'pending',
    owner: String(item.owner || item.agent || 'build').toLowerCase(),
    phase: String(item.phase || guessPhase(item.owner || item.agent) || 'implement'),
    active_form: item.active_form || undefined,
  };
}

function guessPhase(owner) {
  const o = String(owner || '').toLowerCase();
  if (o === 'explore' || o === 'research') return 'research';
  if (o === 'intake') return 'intake';
  if (o === 'strategy') return 'strategy';
  if (o === 'plan') return 'plan';
  if (o === 'monitor') return 'monitor';
  if (o === 'verify') return 'verify';
  if (o === 'general' || o === 'build') return 'execute';
  return 'execute';
}

function syncFromCtx(bb, ctx) {
  if (!bb || !ctx) return bb;
  if (ctx.briefing && ctx.briefing.goal) bb.goal = ctx.briefing.goal;
  if (ctx.doneWhen) bb.doneWhen = ctx.doneWhen;
  if (Array.isArray(ctx.todos)) {
    bb.todos = ctx.todos.map(normalizeTodo).filter((t) => t && t.content);
  }
  if (Array.isArray(ctx.filesTouched)) {
    bb.filesTouched = unique(bb.filesTouched.concat(ctx.filesTouched)).slice(-80);
  }
  bb.previewOk = !!ctx.previewOk;
  if (ctx.previewFailed && Array.isArray(ctx.lastFailures)) {
    bb.previewErrors = unique(
      bb.previewErrors.concat(
        ctx.lastFailures.map((f) => (typeof f === 'string' ? f : f && f.error) || String(f)),
      ),
    ).slice(-30);
  }
  if (ctx.planPath) bb.planPath = ctx.planPath;
  if (ctx.planApproved) bb.planApproved = true;
  if (ctx.requirePlan) bb.requirePlan = true;
  return bb;
}

function applyToCtx(bb, ctx) {
  if (!bb || !ctx) return;
  ctx.blackboard = bb;
  ctx.todos = bb.todos.slice();
  ctx.filesTouched = unique(
    (ctx.filesTouched || []).concat(bb.filesTouched || []),
  ).slice(-80);
  if (bb.planPath) ctx.planPath = bb.planPath;
  if (bb.planApproved) ctx.planApproved = true;
  if (bb.requirePlan) ctx.requirePlan = true;
  if (bb.doneWhen) ctx.doneWhen = bb.doneWhen;
}

function mergeDelegateResult(bb, result) {
  if (!bb || !result) return bb;
  const entry = {
    agent: result.agent || 'general',
    ok: result.ok !== false,
    summary: String(result.summary || result.text || '').slice(0, 500),
    at: new Date().toISOString(),
  };
  bb.delegates.push(entry);
  bb.delegates = bb.delegates.slice(-12);
  if (Array.isArray(result.findings)) {
    bb.findings = bb.findings.concat(result.findings.map(String)).slice(-40);
  }
  if (Array.isArray(result.risks)) {
    bb.risks = bb.risks.concat(result.risks.map(String)).slice(-20);
  }
  if (Array.isArray(result.nextActions)) {
    bb.nextActions = bb.nextActions
      .concat(result.nextActions.map(String))
      .slice(-20);
  }
  if (Array.isArray(result.filesChanged)) {
    bb.filesTouched = unique(
      bb.filesTouched.concat(result.filesChanged.map(String)),
    ).slice(-80);
  }
  if (Array.isArray(result.todos) && result.todos.length) {
    result.todos.forEach((t) => upsertTodo(bb, t));
  }
  return bb;
}

function upsertTodo(bb, item) {
  const t = normalizeTodo(item);
  if (!t || !t.content) return;
  const hit = bb.todos.find((x) => x.id === t.id);
  if (hit) {
    Object.assign(hit, t);
  } else {
    bb.todos.push(t);
  }
}

function recordHandoff(bb, fromAgent, toAgent, note) {
  if (!bb) return;
  bb.handoffs.push({
    from: fromAgent,
    to: toAgent,
    note: String(note || '').slice(0, 400),
    at: new Date().toISOString(),
  });
  bb.handoffs = bb.handoffs.slice(-12);
}

function setPreviewResult(bb, result) {
  if (!bb) return;
  bb.previewOk = !!(result && result.ok);
  bb.lastPreviewPath = (result && result.path) || bb.lastPreviewPath;
  const errs = (result && result.errors) || [];
  if (Array.isArray(errs) && errs.length) {
    bb.previewErrors = errs.map((e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e))).slice(-30);
  } else if (bb.previewOk) {
    bb.previewErrors = [];
  }
}

function formatForPrompt(bb, limit) {
  if (!bb) return '(no blackboard)';
  const cap = limit || 3200;
  const open = (bb.todos || []).filter((t) => t.status !== 'done');
  const lines = [
    '# Team blackboard',
    'Phase: ' + (bb.phase || '(none)') + ' · owner ' + (bb.phaseOwner || '?'),
    'Goal: ' + (bb.goal || '(none)'),
    'Done when: ' + (bb.doneWhen || '(none)'),
    'Strategy: ' + (bb.strategyPath || '(none)'),
    'Plan: ' + (bb.planPath || '(none)') + (bb.planApproved ? ' (approved)' : ''),
    'Specialist: ' +
      (bb.specialist && bb.specialist.name
        ? bb.specialist.name
        : '(stock cast)'),
    'Preview: ' + (bb.previewOk ? 'ok' : bb.previewErrors.length ? 'FAIL' : 'pending'),
  ];
  if (bb.intentContract) {
    lines.push('Intent contract: ' + String(bb.intentContract).slice(0, 400));
  }
  if (
    bb.understandingConfidence != null &&
    !Number.isNaN(Number(bb.understandingConfidence))
  ) {
    lines.push('Understanding confidence: ' + bb.understandingConfidence);
  }
  if (bb.deliverableKind) {
    lines.push('Deliverable kind: ' + bb.deliverableKind);
  }
  if (bb.userCorrections && bb.userCorrections.length) {
    lines.push('User corrections (must honor):');
    bb.userCorrections.slice(-6).forEach((c) => {
      lines.push('- ' + String(c).slice(0, 180));
    });
  }
  if (bb.phaseLog && bb.phaseLog.length) {
    lines.push('Phase log:');
    bb.phaseLog.slice(-6).forEach((e) => {
      const row =
        typeof e === 'string'
          ? e
          : (e && e.phase ? e.phase : '?') +
            (e && e.reason ? ' — ' + e.reason : '') +
            (e && e.at ? ' @ ' + e.at : '');
      lines.push('- ' + String(row).slice(0, 160));
    });
  }
  if (bb.skillsNeeded && bb.skillsNeeded.length) {
    lines.push('Skills: ' + bb.skillsNeeded.join(', '));
  }
  if (bb.toolsNeeded && bb.toolsNeeded.length) {
    lines.push('Tools: ' + bb.toolsNeeded.join(', '));
  }
  if (bb.risks && bb.risks.length) {
    lines.push('Risks:');
    bb.risks.slice(-6).forEach((r) => lines.push('- ' + String(r).slice(0, 160)));
  }
  if (bb.handoffs && bb.handoffs.length) {
    lines.push('Handoffs:');
    bb.handoffs.slice(-4).forEach((h) => {
      const row =
        typeof h === 'string'
          ? h
          : (h && h.from ? h.from : '?') +
            ' → ' +
            (h && h.to ? h.to : '?') +
            (h && h.note ? ': ' + h.note : '');
      lines.push('- ' + String(row).slice(0, 160));
    });
  }
  if (bb.monitorNotes && bb.monitorNotes.length) {
    lines.push('Monitor:');
    bb.monitorNotes.slice(-4).forEach((n) => {
      const t = typeof n === 'string' ? n : n && n.fix_brief ? n.fix_brief : JSON.stringify(n);
      lines.push('- ' + String(t).slice(0, 160));
    });
  }
  if (bb.previewErrors.length) {
    lines.push('Preview errors:');
    bb.previewErrors.slice(0, 8).forEach((e) => lines.push('- ' + e));
  }
  if (open.length) {
    lines.push('Open todos:');
    open.slice(0, 12).forEach((t) => {
      lines.push(
        '- [' +
          (t.owner || '?') +
          '/' +
          (t.phase || '?') +
          '] ' +
          t.id +
          ': ' +
          t.content,
      );
    });
  }
  if (bb.findings.length) {
    lines.push('Findings:');
    bb.findings.slice(-8).forEach((f) => lines.push('- ' + f));
  }
  if (bb.filesTouched.length) {
    lines.push(
      'Files touched: ' + bb.filesTouched.slice(-16).join(', '),
    );
  }
  if (bb.nextActions.length) {
    lines.push('Next actions:');
    bb.nextActions.slice(-6).forEach((a) => lines.push('- ' + a));
  }
  if (bb.delegates.length) {
    lines.push('Recent delegates:');
    bb.delegates.slice(-4).forEach((d) => {
      lines.push(
        '- ' +
          d.agent +
          (d.ok ? ' ok' : ' FAIL') +
          ': ' +
          String(d.summary || '').slice(0, 120),
      );
    });
  }
  const out = lines.join('\n');
  return out.length > cap ? out.slice(0, cap) + '\n…' : out;
}

function unique(arr) {
  const seen = new Set();
  const out = [];
  (arr || []).forEach((x) => {
    const k = String(x);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  });
  return out;
}

function serialize(bb) {
  return createBlackboard(bb);
}

module.exports = {
  createBlackboard,
  normalizeTodo,
  syncFromCtx,
  applyToCtx,
  mergeDelegateResult,
  upsertTodo,
  recordHandoff,
  setPreviewResult,
  formatForPrompt,
  serialize,
};
