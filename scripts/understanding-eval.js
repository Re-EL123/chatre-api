#!/usr/bin/env node
'use strict';

/**
 * Understanding intake eval — offline, no network, no new API route.
 * Usage: node scripts/understanding-eval.js
 */
const assert = require('assert');
const Understanding = require('../lib/understanding');
const { normalizeBriefing } = require('../lib/analyst');
const { MAX_API_FUNCTIONS, ROUTES } = require('../lib/api-surface');
const fs = require('fs');
const path = require('path');

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

case_('api_surface_under_12', () => {
  assert(ROUTES.length <= MAX_API_FUNCTIONS);
  assert(ROUTES.length <= 12);
  const apiDir = path.join(__dirname, '..', 'api');
  const files = fs.readdirSync(apiDir).filter((f) => f.endsWith('.js'));
  assert.strictEqual(files.length, ROUTES.length, 'api/*.js count must match ROUTES');
});

case_('hello_path_minimal', () => {
  const b = normalizeBriefing(null, 'Build a tiny one-page HTML hello world at /home/user/projects/hello/index.html with just an h1 saying Hello Chatre. Write only that file.');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  assert((b.files || []).some((f) => String(f).indexOf('/home/user/projects/hello/index.html') >= 0), 'files=' + JSON.stringify(b.files));
  assert(b.minimal_single_file === true || /only the requested file|single-file/i.test(String(b.done_when||'')), 'minimal');
  const sig = Understanding.extractIntentSignals('Build a tiny one-page HTML hello world at /home/user/projects/hello/index.html with just an h1 saying Hello Chatre. Write only that file.');
  assert(sig && typeof sig === 'object');
});

case_('howto_js_sort', () => {
  const b = normalizeBriefing(null, 'how do I sort an array in JavaScript?');
  assert.strictEqual(b.task_type, 'question', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'answer', 'kind=' + b.deliverable_kind);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  assert(!b.files || !b.files.length, 'files should be empty');
  const sig = Understanding.extractIntentSignals('how do I sort an array in JavaScript?');
  assert(sig && typeof sig === 'object');
});

case_('greeting_hi', () => {
  const b = normalizeBriefing(null, 'hi');
  assert.strictEqual(b.task_type, 'chat', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'answer', 'kind=' + b.deliverable_kind);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('hi');
  assert(sig && typeof sig === 'object');
});

case_('greeting_thanks', () => {
  const b = normalizeBriefing(null, 'thanks!');
  assert.strictEqual(b.task_type, 'chat', 'task_type=' + b.task_type);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('thanks!');
  assert(sig && typeof sig === 'object');
});

case_('pdf_laws', () => {
  const b = normalizeBriefing(null, 'generate a pdf of the 42 laws of maat');
  assert.strictEqual(b.task_type, 'document', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('generate a pdf of the 42 laws of maat');
  assert(sig && typeof sig === 'object');
});

case_('csv_export', () => {
  const b = normalizeBriefing(null, 'create a csv of sales from this table');
  assert.strictEqual(b.task_type, 'document', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('create a csv of sales from this table');
  assert(sig && typeof sig === 'object');
});

case_('git_clone_fix', () => {
  const b = normalizeBriefing(null, 'clone https://github.com/acme/demo and fix the failing tests');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('clone https://github.com/acme/demo and fix the failing tests');
  assert(sig && typeof sig === 'object');
});

case_('ambiguous_cool', () => {
  const b = normalizeBriefing(null, 'make me something cool');
  assert.strictEqual(!!b.needs_clarification, true, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('make me something cool');
  assert(sig && typeof sig === 'object');
});

case_('calculator_app', () => {
  const b = normalizeBriefing(null, 'build a calculator in html css and js');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('build a calculator in html css and js');
  assert(sig && typeof sig === 'object');
});

case_('explain_react', () => {
  const b = normalizeBriefing(null, 'what is React and how does reconciliation work?');
  assert.strictEqual(b.deliverable_kind, 'answer', 'kind=' + b.deliverable_kind);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  assert(!b.files || !b.files.length, 'files should be empty');
  const sig = Understanding.extractIntentSignals('what is React and how does reconciliation work?');
  assert(sig && typeof sig === 'object');
});

case_('debug_crash', () => {
  const b = normalizeBriefing(null, 'debug why the preview crashes with TypeError');
  assert.strictEqual(b.task_type, 'debug', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('debug why the preview crashes with TypeError');
  assert(sig && typeof sig === 'object');
});

case_('browse_example', () => {
  const b = normalizeBriefing(null, 'open https://example.com and tell me the heading');
  assert.strictEqual(b.task_type, 'browser', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('open https://example.com and tell me the heading');
  assert(sig && typeof sig === 'object');
});

case_('research_sources', () => {
  const b = normalizeBriefing(null, 'research the history of maat and cite sources');
  assert.strictEqual(b.task_type, 'research', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('research the history of maat and cite sources');
  assert(sig && typeof sig === 'object');
});

case_('git_commit', () => {
  const b = normalizeBriefing(null, 'git commit my changes with a clear message');
  assert.strictEqual(b.task_type, 'git', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('git commit my changes with a clear message');
  assert(sig && typeof sig === 'object');
});

case_('only_that_file', () => {
  const b = normalizeBriefing(null, 'Write only /home/user/projects/demo/readme.txt saying hello');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert((b.files || []).some((f) => String(f).indexOf('/home/user/projects/demo/readme.txt') >= 0), 'files=' + JSON.stringify(b.files));
  assert(b.minimal_single_file === true || /only the requested file|single-file/i.test(String(b.done_when||'')), 'minimal');
  const sig = Understanding.extractIntentSignals('Write only /home/user/projects/demo/readme.txt saying hello');
  assert(sig && typeof sig === 'object');
});

case_('landing_page', () => {
  const b = normalizeBriefing(null, 'create a landing page for a tea shop');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('create a landing page for a tea shop');
  assert(sig && typeof sig === 'object');
});

case_('todo_app', () => {
  const b = normalizeBriefing(null, 'make a todo app in html');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('make a todo app in html');
  assert(sig && typeof sig === 'object');
});

case_('how_to_build_without_artifact', () => {
  const b = normalizeBriefing(null, 'how do I build a webpack project?');
  assert.strictEqual(b.deliverable_kind, 'answer', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('how do I build a webpack project?');
  assert(sig && typeof sig === 'object');
});

case_('write_pdf_report', () => {
  const b = normalizeBriefing(null, 'write a pdf report about tea brewing');
  assert.strictEqual(b.task_type, 'document', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('write a pdf report about tea brewing');
  assert(sig && typeof sig === 'object');
});

case_('patch_auth', () => {
  const b = normalizeBriefing(null, 'implement auth middleware in typescript');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('implement auth middleware in typescript');
  assert(sig && typeof sig === 'object');
});

case_('fill_form', () => {
  const b = normalizeBriefing(null, 'fill the signup form on the page');
  assert.strictEqual(b.task_type, 'browser', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('fill the signup form on the page');
  assert(sig && typeof sig === 'object');
});

case_('dogfood_qa', () => {
  const b = normalizeBriefing(null, 'dogfood the checkout flow and report bugs');
  assert.strictEqual(b.task_type, 'browser', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('dogfood the checkout flow and report bugs');
  assert(sig && typeof sig === 'object');
});

case_('run_tests_cmd', () => {
  const b = normalizeBriefing(null, 'run the unit tests and show failures');
  assert.strictEqual(b.task_type, 'run', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('run the unit tests and show failures');
  assert(sig && typeof sig === 'object');
});

case_('hello_world_generic', () => {
  const b = normalizeBriefing(null, 'create a hello world html page');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('create a hello world html page');
  assert(sig && typeof sig === 'object');
});

case_('exact_docs_path', () => {
  const b = normalizeBriefing(null, 'create /home/user/documents/notes.md with three bullet points');
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  assert((b.files || []).some((f) => String(f).indexOf('/home/user/documents/notes.md') >= 0), 'files=' + JSON.stringify(b.files));
  const sig = Understanding.extractIntentSignals('create /home/user/documents/notes.md with three bullet points');
  assert(sig && typeof sig === 'object');
});

case_('style_unknown_nonblocking', () => {
  const seed = {'unknowns': ['preferred color theme'], 'confidence': 0.9, 'task_type': 'build', 'deliverable_kind': 'deliver', 'files': ['/home/user/projects/x/index.html']};
  const b = normalizeBriefing(seed, 'build /home/user/projects/x/index.html');
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('build /home/user/projects/x/index.html');
  assert(sig && typeof sig === 'object');
});

case_('blocking_path_unknown', () => {
  const seed = {'unknowns': ['what exact deliverable and where it should live'], 'confidence': 0.4, 'task_type': 'build', 'deliverable_kind': 'deliver'};
  const b = normalizeBriefing(seed, 'build an app for me');
  assert.strictEqual(!!b.needs_clarification, true, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('build an app for me');
  assert(sig && typeof sig === 'object');
});

case_('answer_first', () => {
  const b = normalizeBriefing(null, 'explain binary search with an example');
  assert.strictEqual(b.deliverable_kind, 'answer', 'kind=' + b.deliverable_kind);
  assert(!b.files || !b.files.length, 'files should be empty');
  const sig = Understanding.extractIntentSignals('explain binary search with an example');
  assert(sig && typeof sig === 'object');
});

case_('mixed_research_write', () => {
  const b = normalizeBriefing(null, 'research maat and save notes as a markdown doc');
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('research maat and save notes as a markdown doc');
  assert(sig && typeof sig === 'object');
});

case_('pr_create', () => {
  const b = normalizeBriefing(null, 'open a pull request for the auth branch');
  assert.strictEqual(b.task_type, 'git', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('open a pull request for the auth branch');
  assert(sig && typeof sig === 'object');
});

case_('game_shooter', () => {
  const b = normalizeBriefing(null, 'build a 3d ops shooting game in html css js');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('build a 3d ops shooting game in html css js');
  assert(sig && typeof sig === 'object');
});

case_('single_h1', () => {
  const b = normalizeBriefing(null, 'make index.html at /home/user/projects/p/index.html with just an h1');
  assert((b.files || []).some((f) => String(f).indexOf('/home/user/projects/p/index.html') >= 0), 'files=' + JSON.stringify(b.files));
  assert(b.minimal_single_file === true || /only the requested file|single-file/i.test(String(b.done_when||'')), 'minimal');
  const sig = Understanding.extractIntentSignals('make index.html at /home/user/projects/p/index.html with just an h1');
  assert(sig && typeof sig === 'object');
});

case_('why_error', () => {
  const b = normalizeBriefing(null, 'why is my node script failing with EADDRINUSE?');
  assert.strictEqual(b.task_type, 'debug', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('why is my node script failing with EADDRINUSE?');
  assert(sig && typeof sig === 'object');
});

case_('spreadsheet', () => {
  const b = normalizeBriefing(null, 'make an excel spreadsheet of monthly expenses');
  assert.strictEqual(b.task_type, 'document', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('make an excel spreadsheet of monthly expenses');
  assert(sig && typeof sig === 'object');
});

case_('hey_there', () => {
  const b = normalizeBriefing(null, 'hey there');
  assert.strictEqual(b.task_type, 'chat', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('hey there');
  assert(sig && typeof sig === 'object');
});

case_('deploy_hint', () => {
  const b = normalizeBriefing(null, 'deploy my site to vercel');
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('deploy my site to vercel');
  assert(sig && typeof sig === 'object');
});

case_('refactor_module', () => {
  const b = normalizeBriefing(null, 'refactor the payment module and add tests');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('refactor the payment module and add tests');
  assert(sig && typeof sig === 'object');
});

case_('screenshot_page', () => {
  const b = normalizeBriefing(null, 'take a screenshot of the homepage');
  assert.strictEqual(b.task_type, 'browser', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('take a screenshot of the homepage');
  assert(sig && typeof sig === 'object');
});

case_('cite_web', () => {
  const b = normalizeBriefing(null, 'look up Cloudflare Workers AI quotas and cite sources');
  assert.strictEqual(b.task_type, 'research', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('look up Cloudflare Workers AI quotas and cite sources');
  assert(sig && typeof sig === 'object');
});

case_('empty-ish', () => {
  const b = normalizeBriefing(null, 'ok');
  assert.strictEqual(b.task_type, 'chat', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('ok');
  assert(sig && typeof sig === 'object');
});

case_('path_prefers_message', () => {
  const b = normalizeBriefing(null, 'put the file at /home/user/projects/alpha/beta.js only');
  assert((b.files || []).some((f) => String(f).indexOf('/home/user/projects/alpha/beta.js') >= 0), 'files=' + JSON.stringify(b.files));
  const sig = Understanding.extractIntentSignals('put the file at /home/user/projects/alpha/beta.js only');
  assert(sig && typeof sig === 'object');
});

case_('no_overclarify_tone', () => {
  const seed = {'unknowns': ['tone of voice', 'audience persona', 'what done looks like'], 'task_type': 'build', 'deliverable_kind': 'deliver', 'files': ['/home/user/projects/z/index.html'], 'confidence': 0.88};
  const b = normalizeBriefing(seed, 'build a page at /home/user/projects/z/index.html');
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('build a page at /home/user/projects/z/index.html');
  assert(sig && typeof sig === 'object');
});

case_('clarify_answer_vs_deliver', () => {
  const seed = {'task_type': 'build', 'deliverable_kind': 'answer', 'unknowns': ['should I explain only, or also create files in the workspace'], 'confidence': 0.4};
  const b = normalizeBriefing(seed, 'javascript sorting');
  assert.strictEqual(!!b.needs_clarification, true, 'clarify=' + b.needs_clarification);
  const sig = Understanding.extractIntentSignals('javascript sorting');
  assert(sig && typeof sig === 'object');
});

case_('documents_guide', () => {
  const b = normalizeBriefing(null, 'write a short guide about tea as a document');
  assert.strictEqual(b.task_type, 'document', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('write a short guide about tea as a document');
  assert(sig && typeof sig === 'object');
});

case_('widget_clock', () => {
  const b = normalizeBriefing(null, 'design a clock widget in html');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('design a clock widget in html');
  assert(sig && typeof sig === 'object');
});

case_('gitlab_url', () => {
  const b = normalizeBriefing(null, 'use https://gitlab.com/acme/app and add a README');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('use https://gitlab.com/acme/app and add a README');
  assert(sig && typeof sig === 'object');
});

case_('stopwatch', () => {
  const b = normalizeBriefing(null, 'build a stopwatch app');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('build a stopwatch app');
  assert(sig && typeof sig === 'object');
});

case_('quiz_app', () => {
  const b = normalizeBriefing(null, 'create a quiz app');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('create a quiz app');
  assert(sig && typeof sig === 'object');
});

case_('pure_chat_emoji', () => {
  const b = normalizeBriefing(null, 'hello');
  assert.strictEqual(b.task_type, 'chat', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('hello');
  assert(sig && typeof sig === 'object');
});

case_('fix_typo_page', () => {
  const b = normalizeBriefing(null, 'fix the typo on the about page in the project');
  assert.strictEqual(b.task_type, 'debug', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('fix the typo on the about page in the project');
  assert(sig && typeof sig === 'object');
});

case_('push_branch', () => {
  const b = normalizeBriefing(null, 'git push the feature branch');
  assert.strictEqual(b.task_type, 'git', 'task_type=' + b.task_type);
  const sig = Understanding.extractIntentSignals('git push the feature branch');
  assert(sig && typeof sig === 'object');
});

case_('python_script', () => {
  const b = normalizeBriefing(null, 'write a python script to rename files in a folder into the workspace');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('write a python script to rename files in a folder into the workspace');
  assert(sig && typeof sig === 'object');
});

case_('what_is_closure', () => {
  const b = normalizeBriefing(null, 'what is a closure in JS?');
  assert.strictEqual(b.deliverable_kind, 'answer', 'kind=' + b.deliverable_kind);
  const sig = Understanding.extractIntentSignals('what is a closure in JS?');
  assert(sig && typeof sig === 'object');
});

case_('minimal_flags_extract', () => {
  const b = normalizeBriefing(null, 'tiny one-page hello world html only that file');
  assert(b.minimal_single_file === true || /only the requested file|single-file/i.test(String(b.done_when||'')), 'minimal');
  const sig = Understanding.extractIntentSignals('tiny one-page hello world html only that file');
  assert(sig && typeof sig === 'object');
});

case_('multi_intent_explain_then_build', () => {
  const msg =
    'explain binary search then build a tiny demo at /home/user/projects/bs/index.html';
  const b = normalizeBriefing(null, msg);
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  assert(
    (b.files || []).some((f) => String(f).indexOf('/home/user/projects/bs/index.html') >= 0),
    'files=' + JSON.stringify(b.files),
  );
  const sig = Understanding.extractIntentSignals(msg);
  assert.strictEqual(!!sig.multiIntent, true);
});

case_('answer_only_no_files', () => {
  const msg = 'just answer — do not create any files. What is a closure?';
  const b = normalizeBriefing(null, msg);
  assert.strictEqual(b.deliverable_kind, 'answer', 'kind=' + b.deliverable_kind);
  assert(!b.files || !b.files.length, 'files should be empty');
  assert.strictEqual(!!b.needs_clarification, false);
});

case_('correction_rescore_pdf_path', () => {
  const b = Understanding.applyCorrectionsWithRescore(
    {
      task_type: 'build',
      deliverable_kind: 'deliver',
      confidence: 0.55,
      needs_clarification: true,
      clarification_question: 'PDF or HTML?',
      blocking_unknowns: ['what exact deliverable and where it should live'],
      unknowns: ['what exact deliverable and where it should live'],
      files: [],
      assumptions: [],
      constraints: [],
    },
    ['No, I meant a PDF in /home/user/documents/maat.pdf'],
    'make me something cool',
  );
  assert.strictEqual(b.task_type, 'document', 'task_type=' + b.task_type);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  assert(
    (b.files || []).some((f) => String(f).indexOf('/home/user/documents/maat.pdf') >= 0),
    'files=' + JSON.stringify(b.files),
  );
  assert(Number(b.confidence) >= 0.8, 'confidence=' + b.confidence);
});

case_('score_router_debug_top', () => {
  const r = Understanding.scoreRouter('why is my node script failing with EADDRINUSE?');
  assert.strictEqual(r.top, 'debug', 'top=' + r.top);
  assert(r.confidence >= 0.7, 'conf=' + r.confidence);
});

case_('score_router_howto_not_build', () => {
  const r = Understanding.scoreRouter('how do I build a webpack project?');
  assert.strictEqual(r.top, 'question', 'top=' + r.top);
});

case_('understanding_log_record_shape', () => {
  const UnderstandingLog = require('../lib/understanding-log');
  const b = normalizeBriefing(null, 'make me something cool');
  const rec = UnderstandingLog.buildUnderstandingRecord({
    userMessage: 'make me something cool',
    briefing: b,
    runId: 'run_test',
    outcome: 'analyzed',
  });
  assert.strictEqual(rec.schema, 'chatre.understanding.v1');
  assert.strictEqual(!!rec.clarifyAsked, true);
  assert(rec.metrics && typeof rec.metrics.overClarifyRisk === 'number');
  const log = UnderstandingLog.appendToLog([], rec);
  const summary = UnderstandingLog.summarizeUnderstandingLog(log);
  assert.strictEqual(summary.count, 1);
  assert.strictEqual(summary.clarifyAsked, 1);
});

case_('clarify_feedback_over', () => {
  const fb = Understanding.detectClarifyFeedback('just do whatever you think is best');
  assert(fb && fb.kind === 'over_clarify');
});

case_('path_exact_no_overclarify', () => {
  const b = normalizeBriefing(
    {
      task_type: 'build',
      deliverable_kind: 'deliver',
      confidence: 0.9,
      files: ['/home/user/projects/z/index.html'],
      unknowns: ['tone of the page'],
      needs_clarification: true,
      clarification_question: 'What tone?',
    },
    'build a page at /home/user/projects/z/index.html',
  );
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
});

case_('multi_intent_howto_and_scaffold', () => {
  const msg = 'how does oauth work and also create a login page in html for me';
  const b = normalizeBriefing(null, msg);
  assert.strictEqual(b.deliverable_kind, 'deliver', 'kind=' + b.deliverable_kind);
  assert(['build', 'mixed'].indexOf(b.task_type) >= 0, 'task_type=' + b.task_type);
});

case_('correction_answer_only', () => {
  const b = Understanding.applyCorrectionsWithRescore(
    {
      task_type: 'build',
      deliverable_kind: 'deliver',
      confidence: 0.7,
      files: ['/home/user/projects/x/index.html'],
      needs_clarification: false,
      assumptions: [],
      constraints: [],
      unknowns: [],
    },
    ['Actually just answer — do not create files'],
    'build a page',
  );
  assert.strictEqual(b.deliverable_kind, 'answer');
  assert(!b.files || !b.files.length);
});

case_('calculator_html_no_path_ask', () => {
  const b = normalizeBriefing(null, 'buld a calculator in html');
  assert.strictEqual(b.task_type, 'build', 'task_type=' + b.task_type);
  assert.strictEqual(b.deliverable_kind, 'deliver');
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  assert(
    (b.files || []).some((f) => /\/home\/user\/projects\/calculator\/index\.html/.test(f)),
    'files=' + JSON.stringify(b.files),
  );
});

case_('followup_in_workspace_expands', () => {
  const expanded = Understanding.expandFollowUpMessage('in the workspace', [
    { role: 'user', content: 'build a calculator in html' },
    { role: 'assistant', content: 'Where should it be saved?' },
  ]);
  assert(/calculator/i.test(expanded), 'expanded=' + expanded);
  assert(/do not ask where/i.test(expanded), 'expanded=' + expanded);
  const b = normalizeBriefing(null, expanded);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  assert.strictEqual(b.task_type, 'build');
});

case_('followup_you_recommend_no_clarify', () => {
  const expanded = Understanding.expandFollowUpMessage(
    'implement it the way you recomend fully',
    [{ role: 'user', content: 'build a calculator in html' }],
  );
  const b = normalizeBriefing(null, expanded);
  assert.strictEqual(!!b.needs_clarification, false, 'clarify=' + b.needs_clarification);
  assert.strictEqual(b.deliverable_kind, 'deliver');
});

case_('repo_directive_alone', () => {
  const b = normalizeBriefing(null, 'it should be a repo');
  assert.strictEqual(!!b.needs_clarification, false);
  assert.strictEqual(b.task_type, 'build');
  assert.strictEqual(b.deliverable_kind, 'deliver');
});

case_('chat_proof_light_ok', () => {
  const Delivery = require('../lib/delivery-contract');
  const proof = Delivery.buildDoneProof({
    taskType: 'chat',
    briefing: { task_type: 'chat', deliverable_kind: 'answer', goal: 'hi' },
    doneWhen: 'Friendly reply delivered',
    deliverySuccess: true,
    filesTouched: [],
  });
  assert.strictEqual(proof.ok, true);
  assert.strictEqual(proof.acceptance.ok, true);
});

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
