#!/usr/bin/env node
'use strict';

/**
 * Golden-task evaluation harness for enterprise delivery quality.
 * Runs offline against delivery-contract + plan/workspace helpers (no network).
 *
 * Usage: node scripts/golden-eval.js
 */

const assert = require('assert');
const Delivery = require('../lib/delivery-contract');
const PlanArtifact = require('../lib/plan-artifact');
const TeamPipeline = require('../lib/team-pipeline');
const { redactString } = require('../lib/secrets-redact');
const ModelRouting = require('../lib/model-routing');
const { getVerifyChecklist } = require('../lib/skill-playbooks');

const results = [];

function case_(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.error('FAIL', name, e.message);
  }
}

case_('acceptance defaults for build include preview', () => {
  const tests = Delivery.defaultAcceptanceForTask('build', 'Build a canvas game');
  assert(tests.some((t) => /preview/i.test(t)));
  assert(tests.some((t) => /AGENTS/i.test(t)));
});

case_('evaluateAcceptance fails without preview on build proof', () => {
  const ctx = {
    taskType: 'build',
    deliverySuccess: true,
    previewOk: false,
    filesTouched: ['/home/user/projects/demo/index.html'],
    files: {
      '/home/user/projects/demo/index.html': {
        path: '/home/user/projects/demo/index.html',
        type: 'file',
        content: '<html></html>',
      },
      '/home/user/projects/demo/AGENTS.md': {
        path: '/home/user/projects/demo/AGENTS.md',
        type: 'file',
        content: '# agents',
      },
    },
    acceptanceTests: Delivery.normalizeAcceptanceTests(
      Delivery.defaultAcceptanceForTask('build', 'game'),
    ),
  };
  const gate = Delivery.enterpriseDoneGate(ctx, {
    forcePlan: true,
    acceptance: ctx.acceptanceTests,
  });
  assert(gate && /preview/i.test(gate));
});

case_('evaluateAcceptance passes when preview + files ok', () => {
  const ctx = {
    taskType: 'build',
    deliverySuccess: true,
    previewOk: true,
    filesTouched: ['/home/user/projects/demo/index.html'],
    files: {
      '/home/user/projects/demo/index.html': {
        path: '/home/user/projects/demo/index.html',
        type: 'file',
        content: '<!doctype html><html><body>hi</body></html>',
      },
      '/home/user/projects/demo/AGENTS.md': {
        path: '/home/user/projects/demo/AGENTS.md',
        type: 'file',
        content: '# agents',
      },
    },
  };
  const tests = Delivery.normalizeAcceptanceTests(
    Delivery.defaultAcceptanceForTask('build', 'html app'),
  );
  const ev = Delivery.evaluateAcceptance(ctx, tests);
  assert(ev.ok, JSON.stringify(ev.results));
  const proof = Delivery.buildDoneProof(ctx, {});
  assert(proof.schema === 'chatre.done_proof.v1');
  assert(proof.ok);
});

case_('plan artifact includes acceptance section', () => {
  const md = PlanArtifact.renderPlanMarkdown({
    goal: 'Ship todo app',
    doneWhen: 'preview ok',
    steps: ['scaffold', 'preview'],
    files: ['/home/user/projects/todo/index.html'],
    acceptance: ['preview_project returns ok', 'index.html non-empty'],
  });
  assert(/## Acceptance tests/i.test(md));
  const parsed = PlanArtifact.parsePlanArtifact(md);
  assert(parsed.acceptance.length >= 2);
});

case_('team pipeline mints web specialist for canvas game', () => {
  const intake = TeamPipeline.buildIntake(
    { goal: 'canvas game', task_type: 'build', tools_priority: ['write_file'] },
    'Build a canvas game',
  );
  const strat = TeamPipeline.buildStrategy(intake, { todoCount: 2 });
  assert(strat.mintSpecialist);
  assert(strat.specialistId === 'web-app-specialist');
});

case_('secrets redact api keys', () => {
  const s = redactString('Authorization: Bearer sk-abc1234567890xyz');
  assert(!/sk-abc/.test(s));
  assert(/REDACTED/.test(s));
});

case_('model routing returns env override', () => {
  process.env.CHATRE_MODEL_STRATEGY = 'test-strategy-model';
  const m = ModelRouting.resolveModelForRole('strategy', {
    defaultModel: 'fallback',
  });
  assert.strictEqual(m, 'test-strategy-model');
  delete process.env.CHATRE_MODEL_STRATEGY;
});

case_('skill coding has verify checklist', () => {
  const c = getVerifyChecklist('coding');
  assert(c.length >= 1);
});

case_('document gate requires delivery', () => {
  const gate = Delivery.enterpriseDoneGate(
    { taskType: 'document', deliverySuccess: false },
    { forcePlan: true },
  );
  assert(gate && /ENTERPRISE GATE/i.test(gate));
});


case_('repo gate requires tests when ctx.repo set', () => {
  const ctx = {
    taskType: 'build',
    deliverySuccess: true,
    previewOk: true,
    testsOk: false,
    repo: { mode: 'git', branch: 'main', root: '/home/user/projects/demo' },
    filesTouched: ['/home/user/projects/demo/index.js'],
    files: {
      '/home/user/projects/demo/package.json': {
        path: '/home/user/projects/demo/package.json',
        type: 'file',
        content: JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      },
      '/home/user/projects/demo/AGENTS.md': {
        path: '/home/user/projects/demo/AGENTS.md',
        type: 'file',
        content: '# agents',
      },
    },
  };
  const gate = Delivery.enterpriseDoneGate(ctx, { forcePlan: true, acceptance: [] });
  assert(gate && /run_tests|testsOk/i.test(gate));
  ctx.testsOk = true;
  ctx.lastTest = { ok: true, kind: 'npm', text: 'passed' };
  const gate2 = Delivery.enterpriseDoneGate(ctx, { forcePlan: true, acceptance: [] });
  assert.strictEqual(gate2, null);
  const proof = Delivery.buildDoneProof(ctx, {});
  assert.strictEqual(proof.testsOk, true);
  assert.strictEqual(proof.branch, 'main');
});

case_('search/rg path join helpers', () => {
  const RepoMode = require('../lib/repo-mode');
  const root = '/tmp/chatre-rg-test-root';
  const abs = RepoMode.virtToAbs(root, '/home/user/projects/demo');
  assert(abs.indexOf(root) === 0);
  const virt = RepoMode.absToVirt(root, abs);
  assert.strictEqual(virt, '/home/user/projects/demo');
  const slug = RepoMode.slugFromUrl('https://github.com/acme/hello-world.git');
  assert.strictEqual(slug, 'hello-world');
  const parsed = RepoMode.parseStatusPorcelain(' M src/a.js\n?? new.txt\n');
  assert.strictEqual(parsed.dirty, 2);
});

case_('default acceptance includes run_tests for repo goal', () => {
  const tests = Delivery.defaultAcceptanceForTask(
    'build',
    'Clone https://github.com/acme/app and fix tests',
  );
  assert(tests.some((t) => /run_tests/i.test(t)));
});

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) {
  process.exit(1);
}
