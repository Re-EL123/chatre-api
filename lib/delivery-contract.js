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

function projectProductFiles(files) {
  const map = files || {};
  return Object.keys(map).filter((p) => {
    const f = map[p];
    return (
      f &&
      f.type === 'file' &&
      /\/home\/user\/projects\//.test(p) &&
      !/\/AGENTS\.md$/i.test(p) &&
      String(f.content || '').trim().length > 0
    );
  });
}

function htmlLooksSelfContained(content) {
  const c = String(content || '');
  const hasStyle = /<style[\s>]/i.test(c) || /stylesheet/i.test(c);
  const hasScript = /<script[\s>]/i.test(c);
  if (hasStyle && hasScript && c.trim().length >= 180) return true;
  if (c.trim().length < 350) return false;
  return hasStyle || hasScript;
}

/**
 * True when the workspace actually satisfies a multi-file / app build —
 * not merely "wrote index.html once".
 */
function assessBuildCompleteness(ctx, briefing) {
  const task = String(
    (ctx && ctx.taskType) ||
      (briefing && briefing.task_type) ||
      '',
  ).toLowerCase();
  if (task !== 'build' && task !== 'debug' && task !== 'mixed') {
    return {
      complete: !!(ctx && ctx.deliverySuccess),
      reason: 'non-build',
      present: [],
      missing: [],
    };
  }
  const files = (ctx && ctx.files) || {};
  const present = projectProductFiles(files);
  const goal = String(
    (briefing && (briefing.goal || briefing.understanding)) ||
      (ctx && ctx.doneWhen) ||
      '',
  ).toLowerCase();
  const um = String((ctx && ctx._userMessage) || '').toLowerCase();
  const blob = goal + ' ' + um;

  const expected = Array.isArray(briefing && briefing.files)
    ? briefing.files.map(String).filter(Boolean)
    : [];
  const missingExpected = [];
  expected.forEach((ep) => {
    const abs = ep.indexOf('/home/user/') === 0 ? ep : null;
    const hit = abs
      ? pathExistsNonEmpty(files, abs)
      : present.some(
          (p) =>
            p.endsWith('/' + ep.replace(/^\/+/, '')) ||
            p.indexOf('/' + ep.replace(/^\/+/, '')) >= 0,
        );
    if (!hit) missingExpected.push(ep);
  });
  if (expected.length > 1 && missingExpected.length) {
    return {
      complete: false,
      reason: 'missing_expected_files',
      present,
      missing: missingExpected,
    };
  }

  const htmlPaths = present.filter((p) => /\.html?$/i.test(p));
  const cssPaths = present.filter((p) => /\.css$/i.test(p));
  const jsPaths = present.filter((p) => /\.(js|mjs|cjs|ts)$/i.test(p));
  const wantsCss = /\bcss\b|stylesheet|\.css\b|styling|style it/i.test(blob);
  const wantsJs =
    /\bjavascript\b|\.js\b|script\.js|interact|game|calculator|todo|app|widget|quiz|timer|dashboard/i.test(
      blob,
    );
  const wantsMulti =
    wantsCss ||
    wantsJs ||
    /\b(game|app|website|web app|landing|dashboard|crm|spa)\b/i.test(blob);

  if (!present.length) {
    return {
      complete: false,
      reason: 'no_project_files',
      present,
      missing: ['project files under /home/user/projects'],
    };
  }

  if (wantsMulti && htmlPaths.length && !cssPaths.length && !jsPaths.length) {
    const htmlContent = String((files[htmlPaths[0]] && files[htmlPaths[0]].content) || '');
    if (!htmlLooksSelfContained(htmlContent)) {
      return {
        complete: false,
        reason: 'only_stub_html',
        present,
        missing: wantsCss
          ? ['style.css (or inline <style>)', wantsJs ? 'script.js (or inline <script>)' : null].filter(Boolean)
          : ['script.js / style.css or a complete self-contained index.html'],
      };
    }
  }

  if (wantsCss && !cssPaths.length) {
    const anyInline = htmlPaths.some((p) =>
      /<style[\s>]/i.test(String((files[p] && files[p].content) || '')),
    );
    if (!anyInline) {
      return {
        complete: false,
        reason: 'missing_css',
        present,
        missing: ['style.css or <style> in HTML'],
      };
    }
  }
  if (wantsJs && !jsPaths.length) {
    const anyInline = htmlPaths.some((p) =>
      /<script[\s>]/i.test(String((files[p] && files[p].content) || '')),
    );
    if (!anyInline) {
      return {
        complete: false,
        reason: 'missing_js',
        present,
        missing: ['script.js or <script> in HTML'],
      };
    }
  }

  return {
    complete: !!(ctx && ctx.deliverySuccess) && present.length > 0,
    reason: 'ok',
    present,
    missing: [],
  };
}

function evaluateOneTest(test, ctx) {
  const text = String((test && test.text) || '').toLowerCase();
  const files = (ctx && ctx.files) || {};
  const touched = (ctx && ctx.filesTouched) || [];
  const kind = String(
    (ctx && ctx.taskType) ||
      (ctx && ctx.briefing && ctx.briefing.task_type) ||
      '',
  ).toLowerCase();
  const deliverableKind = String(
    (ctx && ctx.briefing && ctx.briefing.deliverable_kind) || '',
  ).toLowerCase();

  // Chat / explain-only: text reply is the deliverable — do not fail on workspace proofs.
  if (
    kind === 'chat' ||
    kind === 'question' ||
    deliverableKind === 'answer' ||
    /friendly reply|direct answer|user (has|received)|user replies/i.test(text)
  ) {
    if (
      kind === 'chat' ||
      kind === 'question' ||
      deliverableKind === 'answer' ||
      (ctx && ctx.deliverySuccess)
    ) {
      return {
        id: test.id,
        text: test.text,
        pass: true,
        evidence: 'answer deliverable',
      };
    }
  }

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
    const completeness = assessBuildCompleteness(ctx, ctx && ctx.briefing);
    const okHtml = pathExistsNonEmpty(files, /\.html?$/i);
    const ok =
      okHtml &&
      (completeness.complete ||
        completeness.reason === 'non-build' ||
        completeness.reason === 'ok');
    return {
      id: test.id,
      text: test.text,
      pass: !!ok,
      evidence: ok
        ? 'html present'
        : completeness.missing && completeness.missing.length
          ? 'incomplete: ' + completeness.missing.slice(0, 3).join(', ')
          : 'no html',
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
    const completeness = assessBuildCompleteness(ctx, ctx && ctx.briefing);
    const ok =
      completeness.complete ||
      ((completeness.present || []).length > 0 &&
        completeness.reason === 'ok');
    return {
      id: test.id,
      text: test.text,
      pass: !!ok,
      evidence: ok
        ? 'project files present (' + (completeness.present || []).length + ')'
        : completeness.reason === 'only_stub_html' ||
            completeness.reason === 'missing_css' ||
            completeness.reason === 'missing_js' ||
            completeness.reason === 'missing_expected_files'
          ? 'incomplete project: ' +
            (completeness.missing || []).slice(0, 3).join(', ')
          : 'no project files',
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
  if (/\bcss\b|stylesheet|style\.css/.test(text)) {
    const hasFile = pathExistsNonEmpty(files, /\.css$/i);
    const hasInline = Object.keys(files).some((p) => {
      const f = files[p];
      return (
        f &&
        f.type === 'file' &&
        /\.html?$/i.test(p) &&
        /<style[\s>]/i.test(String(f.content || ''))
      );
    });
    const ok = hasFile || hasInline;
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? (hasFile ? 'css file' : 'inline style') : 'no css',
    };
  }
  if (/\bjavascript\b|\.js\b|script\.js|<script/.test(text)) {
    const hasFile = pathExistsNonEmpty(files, /\.(js|mjs|cjs|ts)$/i);
    const hasInline = Object.keys(files).some((p) => {
      const f = files[p];
      return (
        f &&
        f.type === 'file' &&
        /\.html?$/i.test(p) &&
        /<script[\s>]/i.test(String(f.content || ''))
      );
    });
    const ok = hasFile || hasInline;
    return {
      id: test.id,
      text: test.text,
      pass: ok,
      evidence: ok ? (hasFile ? 'js file' : 'inline script') : 'no javascript',
    };
  }
  // Qualitative / unmatched criteria: require real delivery AND do not
  // auto-pass just because any file was touched (that hid weak outputs).
  const delivered = !!(ctx && ctx.deliverySuccess);
  const completeness = assessBuildCompleteness(ctx, ctx && ctx.briefing);
  const previewOk = !!(ctx && ctx.previewOk);
  let ok = delivered && (completeness.complete || completeness.reason === 'non-build');
  let evidence = ok
    ? 'deliverySuccess'
    : completeness.missing && completeness.missing.length
      ? 'incomplete: ' + completeness.missing.slice(0, 3).join(', ')
      : 'no delivery evidence';
  if (ok && (kind === 'build' || kind === 'debug') && /preview|live|work|ui|interact/.test(text)) {
    ok = previewOk;
    evidence = previewOk ? 'previewOk' : 'preview not ok';
  }
  return {
    id: test.id,
    text: test.text,
    pass: ok,
    evidence,
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
    const completeness = assessBuildCompleteness(ctx, (ctx && ctx.briefing) || null);
    if (!completeness.complete) {
      return (
        '[internal] ENTERPRISE GATE: delivery incomplete (' +
        (completeness.reason || 'missing files') +
        '). Still need: ' +
        ((completeness.missing || []).slice(0, 4).join(', ') || 'more project files') +
        '. Write the remaining files with full content, then preview_project. Do not claim done.'
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
  const taskType = String((ctx && ctx.taskType) || '').toLowerCase();
  const deliverableKind = String(
    (ctx && ctx.briefing && ctx.briefing.deliverable_kind) || '',
  ).toLowerCase();
  const lightAnswer =
    taskType === 'chat' ||
    taskType === 'question' ||
    deliverableKind === 'answer';
  const acceptance = lightAnswer
    ? {
        ok: true,
        results: [
          {
            id: 'at1',
            text: (ctx && ctx.doneWhen) || 'Direct answer delivered',
            pass: true,
            evidence: 'light_chat',
          },
        ],
        passed: 1,
        failed: 0,
        total: 1,
      }
    : evaluateAcceptance(ctx, o.acceptance || null);
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
  const testsRequired = !!(repo && repo.mode === 'git') && !lightAnswer;
  const forceFail =
    !!o.forceFail ||
    o.stopReason === 'consecutive_tool_failures' ||
    o.stopReason === 'no_delivery_progress';
  const baseOk =
    lightAnswer ||
    (acceptance.ok &&
      !(
        ['build', 'debug'].indexOf(taskType) >= 0 && !(ctx && ctx.previewOk)
      ) &&
      !(
        testsRequired &&
        !(ctx && ctx.testsOk) &&
        !(ctx && ctx.lastTest && ctx.lastTest.skipped)
      ));
  const scaffoldUsed = !!(
    o.scaffoldUsed ||
    (ctx && ctx._scaffoldUsed) ||
    /scaffold/i.test(String(o.stopReason || '')) ||
    ((ctx && ctx.blackboard && ctx.blackboard.risks) || []).some(function (r) {
      return /scaffold/i.test(String(r || ''));
    })
  );
  const completeness = assessBuildCompleteness(ctx, (ctx && ctx.briefing) || null);
  const incompleteBuild =
    ['build', 'debug', 'mixed'].indexOf(taskType) >= 0 &&
    !completeness.complete &&
    completeness.reason !== 'non-build';
  const blockedStop =
    forceFail ||
    [
      'consecutive_tool_failures',
      'no_delivery_progress',
      'provider_error',
      'quota_exhausted',
      'rate_limited',
      'gate_stall',
      'incomplete_delivery',
    ].indexOf(String(o.stopReason || '')) >= 0;
  const okFinal = forceFail || incompleteBuild ? false : baseOk;
  let outcomeKind = 'delivered';
  if (lightAnswer) {
    outcomeKind = 'chat-only';
  } else if (
    blockedStop &&
    !(scaffoldUsed && filesTouched.length > 0) &&
    !incompleteBuild
  ) {
    outcomeKind = 'blocked';
  } else if (
    scaffoldUsed ||
    incompleteBuild ||
    (acceptance && acceptance.ok === false) ||
    (acceptance && acceptance.failed > 0) ||
    (!okFinal && filesTouched.length > 0) ||
    (['build', 'debug'].indexOf(taskType) >= 0 &&
      filesTouched.length > 0 &&
      !(ctx && ctx.previewOk))
  ) {
    outcomeKind = 'partial';
  } else if (!okFinal) {
    outcomeKind = 'blocked';
  }
  return {
    schema: 'chatre.done_proof.v1',
    ok: forceFail || incompleteBuild ? false : baseOk,
    outcomeKind,
    scaffoldUsed: !!scaffoldUsed,
    deliveryComplete: !incompleteBuild,
    completenessReason: completeness.reason || null,
    missingFiles: (completeness.missing || []).slice(0, 8),
    stopReason: o.stopReason || null,
    goal: (ctx && ctx.briefing && ctx.briefing.goal) || (ctx && ctx.blackboard && ctx.blackboard.goal) || '',
    doneWhen: (ctx && ctx.doneWhen) || '',
    taskType: (ctx && ctx.taskType) || '',
    activeProject: (ctx && ctx.activeProject) || null,
    revision: ctx && ctx.revision != null ? ctx.revision : null,
    filesTouched,
    fileCount: filesTouched.length,
    // Light chat/answer: don't fake workspace/CI/preview green checks.
    previewOk: forceFail
      ? false
      : lightAnswer
        ? null
        : !!(ctx && ctx.previewOk),
    previewUrl: lightAnswer ? null : previewUrl,
    localhost: lightAnswer ? null : previewUrl,
    testsOk: forceFail
      ? false
      : lightAnswer
        ? null
        : !!(ctx && ctx.testsOk),
    lastTest: (ctx && ctx.lastTest) || null,
    prUrl: (ctx && ctx.lastPr && ctx.lastPr.html_url) || null,
    prNumber: (ctx && ctx.lastPr && ctx.lastPr.number) || null,
    ciOk: forceFail
      ? false
      : lightAnswer
        ? null
        : !!(ctx && ctx.ciOk),
    lastCi: (ctx && ctx.lastCi) || null,
    branch: lightAnswer
      ? null
      : (repo && repo.branch) || (ctx && ctx.git && ctx.git.branch) || null,
    head: lightAnswer ? null : (repo && repo.head) || null,
    repo: lightAnswer
      ? null
      : repo
      ? {
          mode: repo.mode,
          remoteUrl: repo.remoteUrl || null,
          root: repo.root || null,
          branch: repo.branch || null,
          head: repo.head || null,
          dirty: repo.dirty != null ? repo.dirty : null,
        }
      : null,
    acceptance: forceFail
      ? {
          ok: false,
          results: [
            {
              id: 'early_stop',
              text: o.stopReason || 'Stopped without reliable delivery',
              pass: false,
              evidence: 'early_stop',
            },
          ].concat((acceptance && acceptance.results) || []),
          passed: 0,
          failed: 1 + ((acceptance && acceptance.failed) || 0),
          total: 1 + ((acceptance && acceptance.total) || 0),
        }
      : acceptance,
    phase: (ctx && ctx.blackboard && ctx.blackboard.phase) || null,
    specialist:
      (ctx && ctx.blackboard && ctx.blackboard.specialist && ctx.blackboard.specialist.name) ||
      null,
    risks,
    rollbackNote: lightAnswer
      ? 'Chat reply — no workspace rollback needed.'
      : forceFail
        ? 'Run stopped early — do not treat as successful delivery. Fix blockers using inventory paths.'
        : incompleteBuild
          ? 'Partial delivery — missing: ' +
            ((completeness.missing || []).slice(0, 4).join(', ') ||
              completeness.reason) +
            '. Do not claim the app is complete.'
          : 'Revert by restoring prior workspace revision or deleting filesTouched paths if this run is unwanted.',
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
      /game|app|web|html|css|javascript|\.js\b/i.test(g)
        ? 'index.html (or entry HTML) is non-empty'
        : null,
      /css|stylesheet|style/i.test(g) ? 'CSS present (file or inline)' : null,
      /javascript|\.js\b|script|interact|game|calculator|todo/i.test(g)
        ? 'JavaScript present (file or inline)'
        : null,
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
  assessBuildCompleteness,
  projectProductFiles,
  htmlLooksSelfContained,
};
