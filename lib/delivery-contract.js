'use strict';

/**
 * Enterprise delivery contract: acceptance tests, hard done-gates, proof payload.
 */

const PlanArtifact = require('./plan-artifact');

function normalizeAcceptanceTests(input) {
  const out = [];
  const push = (raw, source) => {
    const s = String(raw || '').trim();
    if (!s) return;
    out.push({
      id: 'at' + (out.length + 1),
      text: s.slice(0, 400),
      source: source || 'briefing',
    });
  };
  if (!input) return out;
  if (Array.isArray(input)) {
    input.forEach((x) => {
      if (typeof x === 'string') push(x, 'briefing');
      else if (x && typeof x === 'object') push(x.text || x.content || x.title, x.source);
    });
    return out.slice(0, 20);
  }
  if (typeof input === 'string') {
    input.split('\n').forEach((line) => {
      const t = line.replace(/^[-*\d.)\s]+/, '').trim();
      if (t) push(t, 'plan');
    });
  }
  return out.slice(0, 20);
}

function acceptanceFromBriefingAndPlan(briefing, ctx) {
  const b = briefing || (ctx && ctx.briefing) || {};
  let tests = normalizeAcceptanceTests(
    b.acceptance_tests || b.acceptanceTests || b.success_criteria,
  );
  let planText = '';
  if (ctx && ctx.planPath && ctx.files && ctx.files[ctx.planPath]) {
    planText = String(ctx.files[ctx.planPath].content || '');
  } else if (ctx && ctx.files) {
    const found = PlanArtifact.findExistingPlan(ctx.files);
    if (found) planText = found.content;
  }
  if (planText) {
    const parsed = PlanArtifact.parsePlanArtifact(planText);
    if (parsed && Array.isArray(parsed.acceptance) && parsed.acceptance.length) {
      tests = normalizeAcceptanceTests(parsed.acceptance).concat(tests);
    }
  }
  // Dedupe by text
  const seen = new Set();
  const unique = [];
  tests.forEach((t) => {
    const k = t.text.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    unique.push(t);
  });
  return unique.slice(0, 16);
}

function pathExistsNonEmpty(files, pathOrRe) {
  const map = files || {};
  const keys = Object.keys(map);
  if (pathOrRe instanceof RegExp) {
    return keys.some((p) => {
      const f = map[p];
      return (
        pathOrRe.test(p) &&
        f &&
        f.type === 'file' &&
        String(f.content || '').trim().length > 0
      );
    });
  }
  const f = map[pathOrRe];
  return !!(f && f.type === 'file' && String(f.content || '').trim().length > 0);
}

function evaluateOneTest(test, ctx) {
  const text = String((test && test.text) || '').toLowerCase();
  const files = (ctx && ctx.files) || {};
  const touched = (ctx && ctx.filesTouched) || [];

  if (/preview|live\s*preview|localhost/.test(text)) {
    const ok = !!(ctx && ctx.previewOk);
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? 'previewOk' : 'preview not ok',
    };
  }
  if (/pdf/.test(text)) {
    const ok = pathExistsNonEmpty(files, /\.pdf$/i);
    return { id: test.id, text: test.text, pass: ok, evidence: ok ? 'pdf present' : 'no pdf' };
  }
  if (/agents\.md/.test(text)) {
    const ok = pathExistsNonEmpty(files, /\/AGENTS\.md$/i);
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? 'AGENTS.md present' : 'AGENTS.md missing',
    };
  }
  if (/index\.html|\.html\b/.test(text)) {
    const ok = pathExistsNonEmpty(files, /\.html?$/i);
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? 'html present' : 'no html',
    };
  }
  if (/readme/.test(text)) {
    const ok = pathExistsNonEmpty(files, /\/README\.md$/i);
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? 'README present' : 'README missing',
    };
  }
  if (/commit|git/.test(text) && !/test/.test(text)) {
    const ok = !!(ctx && ctx.gitCommitted);
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? 'git committed' : 'no commit',
    };
  }
  if (/run_tests|tests?\s*(pass|green|ok)|testsOk/.test(text)) {
    const ok = !!(ctx && ctx.testsOk);
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok
        ? 'testsOk'
        : (ctx && ctx.lastTest && ctx.lastTest.text) || 'tests not ok',
    };
  }
  if (/\bpull request\b|\bpr\b|create_pull_request/.test(text)) {
    const ok = !!(ctx && ctx.lastPr && (ctx.lastPr.html_url || ctx.lastPr.number));
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok
        ? 'PR #' + (ctx.lastPr.number || '') + ' ' + (ctx.lastPr.html_url || '')
        : 'no PR',
    };
  }
  if (/\bci\b|checks? green|ciOk/.test(text)) {
    const ok = !!(ctx && ctx.ciOk);
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? 'ciOk' : 'CI not green',
    };
  }
  if (/\/home\/user\/projects|project files|workspace file/.test(text)) {
    const ok =
      touched.some((p) => /\/home\/user\/projects\//.test(p)) ||
      pathExistsNonEmpty(files, /\/home\/user\/projects\/.+/);
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? 'project files present' : 'no project files',
    };
  }
  if (/\/home\/user\/documents|document/.test(text)) {
    const ok =
      touched.some((p) => /\/home\/user\/documents\//.test(p)) ||
      pathExistsNonEmpty(files, /\/home\/user\/documents\/.+/);
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? 'document present' : 'no document',
    };
  }
  // Generic: delivery happened
  const ok = !!(ctx && ctx.deliverySuccess) || touched.length > 0;
  return {
    id: test.id,
    text: test.text,
    pass: ok,
    evidence: ok ? 'deliverySuccess/filesTouched' : 'no delivery evidence',
  };
}

function evaluateAcceptance(ctx, tests) {
  const list = Array.isArray(tests) ? tests : acceptanceFromBriefingAndPlan(null, ctx);
  const results = list.map((t) => evaluateOneTest(t, ctx));
  const failed = results.filter((r) => !r.pass);
  return {
    ok: failed.length === 0,
    results,
    passed: results.filter((r) => r.pass).length,
    failed: failed.length,
    total: results.length,
  };
}

/**
 * Hard enterprise done-gate. Returns null if OK to finish, else internal nudge.
 */
function enterpriseDoneGate(ctx, opts) {
  const o = opts || {};
  const kind = String(
    (ctx && ctx.taskType) || (ctx && ctx.briefing && ctx.briefing.task_type) || 'mixed',
  ).toLowerCase();
  if (kind === 'chat' || kind === 'question') return null;
  if (o.forcePlan === false) return null;

  if (kind === 'build' || kind === 'debug') {
    if (!(ctx && ctx.deliverySuccess)) {
      return (
        '[internal] ENTERPRISE GATE: deliver real files with write_file under the active project before done.'
      );
    }
    if (!(ctx && ctx.previewOk)) {
      return (
        '[internal] ENTERPRISE GATE: preview_project must return ok before done (verify owns proof).'
      );
    }
  }
  if (kind === 'document') {
    if (!(ctx && ctx.deliverySuccess)) {
      return (
        '[internal] ENTERPRISE GATE: create_pdf/create_document/write_file must succeed before done.'
      );
    }
  }

  const RepoMode = require('./repo-mode');
  const repoActive = !!(ctx && ctx.repo && ctx.repo.mode === 'git');
  const hasTests = RepoMode.hasTestScript(ctx);
  const staticSkip =
    !!(ctx && ctx.lastTest && ctx.lastTest.skipped && ctx.lastTest.kind === 'static');
  if (
    (repoActive || ((kind === 'build' || kind === 'debug' || kind === 'git') && hasTests)) &&
    !(ctx && ctx.testsOk)
  ) {
    if (!(staticSkip && ctx && ctx.previewOk && !hasTests)) {
      return (
        '[internal] ENTERPRISE GATE: run_tests must pass (testsOk) before done for repo/build tasks. Static HTML without a test script may use preview_project instead.'
      );
    }
  }

  const acceptance = evaluateAcceptance(ctx, o.acceptance || null);
  if (acceptance.total > 0 && !acceptance.ok) {
    const gaps = acceptance.results
      .filter((r) => !r.pass)
      .slice(0, 6)
      .map((r) => '- ' + r.text + ' (' + r.evidence + ')')
      .join('\n');
    return (
      '[internal] ENTERPRISE GATE: acceptance tests failed:\n' +
      gaps +
      '\nFix with tools, then re-verify. Do not narrate this message.'
    );
  }

  if (
    ctx &&
    ctx.requirePlan &&
    !(ctx.planPath || (ctx.blackboard && ctx.blackboard.planPath))
  ) {
    return (
      '[internal] ENTERPRISE GATE: approved-plan runs need a PLAN.md artifact before done.'
    );
  }

  return null;
}

function buildDoneProof(ctx, opts) {
  const o = opts || {};
  const acceptance = evaluateAcceptance(ctx, o.acceptance || null);
  const filesTouched = ((ctx && ctx.filesTouched) || []).slice(-40);
  const previewUrl =
    o.previewUrl ||
    (ctx && ctx.blackboard && ctx.blackboard.lastPreviewUrl) ||
    null;
  const risks = (
    (ctx && ctx.blackboard && ctx.blackboard.risks) ||
    []
  ).slice(-8);
  const repo = (ctx && ctx.repo) || null;
  const testsRequired = !!(repo && repo.mode === 'git');
  return {
    schema: 'chatre.done_proof.v1',
    ok:
      acceptance.ok &&
      !(
        ['build', 'debug'].indexOf(
          String((ctx && ctx.taskType) || '').toLowerCase(),
        ) >= 0 && !(ctx && ctx.previewOk)
      ) &&
      !(testsRequired && !(ctx && ctx.testsOk) && !(ctx && ctx.lastTest && ctx.lastTest.skipped)),
    goal: (ctx && ctx.briefing && ctx.briefing.goal) || (ctx && ctx.blackboard && ctx.blackboard.goal) || '',
    doneWhen: (ctx && ctx.doneWhen) || '',
    taskType: (ctx && ctx.taskType) || '',
    activeProject: (ctx && ctx.activeProject) || null,
    revision: ctx && ctx.revision != null ? ctx.revision : null,
    filesTouched,
    fileCount: filesTouched.length,
    previewOk: !!(ctx && ctx.previewOk),
    previewUrl,
    localhost: previewUrl,
    testsOk: !!(ctx && ctx.testsOk),
    lastTest: (ctx && ctx.lastTest) || null,
    prUrl: (ctx && ctx.lastPr && ctx.lastPr.html_url) || null,
    prNumber: (ctx && ctx.lastPr && ctx.lastPr.number) || null,
    ciOk: !!(ctx && ctx.ciOk),
    lastCi: (ctx && ctx.lastCi) || null,
    branch: (repo && repo.branch) || (ctx && ctx.git && ctx.git.branch) || null,
    head: (repo && repo.head) || null,
    repo: repo
      ? {
          mode: repo.mode,
          remoteUrl: repo.remoteUrl || null,
          root: repo.root || null,
          branch: repo.branch || null,
          head: repo.head || null,
          dirty: repo.dirty != null ? repo.dirty : null,
        }
      : null,
    acceptance,
    phase: (ctx && ctx.blackboard && ctx.blackboard.phase) || null,
    specialist:
      (ctx && ctx.blackboard && ctx.blackboard.specialist && ctx.blackboard.specialist.name) ||
      null,
    risks,
    rollbackNote:
      'Revert by restoring prior workspace revision or deleting filesTouched paths if this run is unwanted.',
    at: new Date().toISOString(),
  };
}

function defaultAcceptanceForTask(taskType, goal, ctx) {
  const kind = String(taskType || '').toLowerCase();
  const g = String(goal || '');
  const repoActive = !!(ctx && ctx.repo && ctx.repo.mode === 'git');
  const looksRepo = repoActive || /github\.com|git clone|repo/i.test(g);
  if (kind === 'build' || kind === 'debug') {
    const tests = [
      'Project files exist under /home/user/projects',
      'preview_project returns ok',
      /game|app|web|html/i.test(g) ? 'index.html (or entry HTML) is non-empty' : null,
      'AGENTS.md exists for the active project',
    ];
    if (looksRepo || /test|pytest|npm test/i.test(g)) {
      tests.push('run_tests passes');
    }
    return tests.filter(Boolean);
  }
  if (kind === 'document') {
    return ['Document or PDF exists under /home/user/documents'];
  }
  if (kind === 'git') {
    return [
      'Git commit recorded in workspace',
      looksRepo ? 'run_tests passes' : null,
    ].filter(Boolean);
  }
  return [];
}

module.exports = {
  normalizeAcceptanceTests,
  acceptanceFromBriefingAndPlan,
  evaluateAcceptance,
  evaluateOneTest,
  enterpriseDoneGate,
  buildDoneProof,
  defaultAcceptanceForTask,
};
