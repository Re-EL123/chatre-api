#!/usr/bin/env node
'use strict';

/**
 * Offline understanding classifier trainer.
 * No new API route — writes data/understanding-classifier.json
 *
 * Usage:
 *   node scripts/train-understanding-classifier.js
 *   node scripts/train-understanding-classifier.js --data path/to/extra.jsonl
 */

const fs = require('fs');
const path = require('path');
const Understanding = require('../lib/understanding');
const {
  FEATURE_NAMES,
  TASK_TYPES,
  KIND_TYPES,
  extractFeatureVector,
} = require('../lib/understanding-features');
const Classifier = require('../lib/understanding-classifier');

const OUT_DATA = path.join(__dirname, '..', 'data', 'understanding-classifier.json');
const OUT_LIB = path.join(
  __dirname,
  '..',
  'lib',
  'understanding-classifier.artifact.json',
);
const SEED = path.join(__dirname, '..', 'data', 'understanding-seed.jsonl');

function seedExamples() {
  return [
    { message: 'hi', task_type: 'chat', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'hello', task_type: 'chat', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'thanks!', task_type: 'chat', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'how do I sort an array in JavaScript?', task_type: 'question', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'what is a closure in JS?', task_type: 'question', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'explain binary search with an example', task_type: 'question', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'how do I build a webpack project?', task_type: 'question', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'just answer — do not create any files. What is a closure?', task_type: 'question', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'build a calculator in html', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'buld a calculator in html', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'Build a tiny one-page HTML hello world at /home/user/projects/hello/index.html with just an h1. Write only that file.', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'make a todo app in html', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'build a stopwatch app', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'create a quiz app', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'build a 3d ops shooting game in html css js', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'make me something cool', task_type: 'mixed', deliverable_kind: 'deliver', needs_clarify: true },
    { message: 'build an app for me', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: true },
    { message: 'generate a pdf of the 42 laws of maat', task_type: 'document', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'create a csv of sales from this table', task_type: 'document', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'make an excel spreadsheet of monthly expenses', task_type: 'document', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'write a short guide about tea as a document', task_type: 'document', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'write a pdf report about tea brewing', task_type: 'document', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'research maat and save notes as a markdown doc', task_type: 'document', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'why is my node script failing with EADDRINUSE?', task_type: 'debug', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'debug why the preview crashes with TypeError', task_type: 'debug', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'fix the typo on the about page in the project', task_type: 'debug', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'open https://example.com and tell me the heading', task_type: 'browser', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'fill the signup form on the page', task_type: 'browser', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'dogfood the checkout flow and report bugs', task_type: 'browser', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'research the history of maat and cite sources', task_type: 'research', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'look up Cloudflare Workers AI quotas and cite sources', task_type: 'research', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'clone https://github.com/acme/demo and fix the failing tests', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'git commit my changes with a clear message', task_type: 'git', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'git push the feature branch', task_type: 'git', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'open a pull request for the auth branch', task_type: 'git', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'run the unit tests and show failures', task_type: 'run', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'explain binary search then build a tiny demo at /home/user/projects/bs/index.html', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'create a landing page for a tea shop', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'write a python script to rename files in a folder into the workspace', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'deploy my site to vercel', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'refactor the payment module and add tests', task_type: 'build', deliverable_kind: 'deliver', needs_clarify: false },
    { message: 'ok', task_type: 'chat', deliverable_kind: 'answer', needs_clarify: false },
    { message: 'hey there', task_type: 'chat', deliverable_kind: 'answer', needs_clarify: false },
  ];
}

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function labelFromBriefing(message) {
  const b = require('../lib/analyst').normalizeBriefing(null, message);
  return {
    message,
    task_type: b.task_type || 'mixed',
    deliverable_kind: b.deliverable_kind || 'mixed',
    needs_clarify: !!b.needs_clarification,
    source: 'normalizeBriefing',
  };
}

function toExample(row) {
  const message = String(row.message || row.userMessage || row.text || '').trim();
  if (!message) return null;
  let task = String(row.task_type || (row.label && row.label.task_type) || '').toLowerCase();
  let kind = String(
    row.deliverable_kind || (row.label && row.label.deliverable_kind) || '',
  ).toLowerCase();
  let clarify =
    row.needs_clarify != null
      ? !!row.needs_clarify
      : row.needs_clarification != null
        ? !!row.needs_clarification
        : row.label && row.label.needs_clarify != null
          ? !!row.label.needs_clarify
          : null;

  if (!task || !kind || clarify == null) {
    const auto = labelFromBriefing(message);
    task = task || auto.task_type;
    kind = kind || auto.deliverable_kind;
    if (clarify == null) clarify = auto.needs_clarify;
  }
  if (TASK_TYPES.indexOf(task) < 0) task = 'mixed';
  if (KIND_TYPES.indexOf(kind) < 0) kind = 'mixed';

  const signals = Understanding.extractIntentSignals(message);
  const x = extractFeatureVector(message, signals, {
    isProceedDirective: Understanding.isProceedDirective,
    isWorkspaceDirective: Understanding.isWorkspaceDirective,
    isRepoDirective: Understanding.isRepoDirective,
  });
  return {
    message,
    x,
    task,
    kind,
    clarify: clarify ? 1 : 0,
    source: row.source || 'seed',
  };
}

function zeros(n) {
  return Array(n).fill(0);
}

function softmax(logits) {
  const max = Math.max.apply(null, logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

function sigmoid(v) {
  if (v >= 0) return 1 / (1 + Math.exp(-v));
  const z = Math.exp(v);
  return z / (1 + z);
}

function train(examples, opts) {
  const o = opts || {};
  const epochs = o.epochs || 220;
  const lr = o.lr || 0.35;
  const l2 = o.l2 || 0.002;
  const nFeat = FEATURE_NAMES.length;
  const taskW = TASK_TYPES.map(() => zeros(nFeat));
  const kindW = KIND_TYPES.map(() => zeros(nFeat));
  const clarifyW = zeros(nFeat);

  for (let ep = 0; ep < epochs; ep++) {
    // shuffle
    for (let i = examples.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = examples[i];
      examples[i] = examples[j];
      examples[j] = t;
    }
    examples.forEach((ex) => {
      const x = ex.x;
      // task softmax
      const taskLogits = taskW.map((w) => {
        let s = 0;
        for (let i = 0; i < nFeat; i++) s += w[i] * x[i];
        return s;
      });
      const taskP = softmax(taskLogits);
      const taskY = TASK_TYPES.indexOf(ex.task);
      taskW.forEach((w, c) => {
        const grad = taskP[c] - (c === taskY ? 1 : 0);
        for (let i = 0; i < nFeat; i++) {
          w[i] -= lr * (grad * x[i] + l2 * w[i]);
        }
      });

      // kind softmax
      const kindLogits = kindW.map((w) => {
        let s = 0;
        for (let i = 0; i < nFeat; i++) s += w[i] * x[i];
        return s;
      });
      const kindP = softmax(kindLogits);
      const kindY = KIND_TYPES.indexOf(ex.kind);
      kindW.forEach((w, c) => {
        const grad = kindP[c] - (c === kindY ? 1 : 0);
        for (let i = 0; i < nFeat; i++) {
          w[i] -= lr * (grad * x[i] + l2 * w[i]);
        }
      });

      // clarify logistic
      let z = 0;
      for (let i = 0; i < nFeat; i++) z += clarifyW[i] * x[i];
      const p = sigmoid(z);
      const g = p - ex.clarify;
      for (let i = 0; i < nFeat; i++) {
        clarifyW[i] -= lr * (g * x[i] + l2 * clarifyW[i]);
      }
    });
  }

  return { taskWeights: taskW, kindWeights: kindW, clarifyWeights: clarifyW };
}

function evaluate(examples, artifact) {
  let taskOk = 0;
  let kindOk = 0;
  let clarifyOk = 0;
  examples.forEach((ex) => {
    const pred = Classifier.predictFromFeatures(ex.x, artifact);
    if (!pred) return;
    if (pred.task_type === ex.task) taskOk++;
    if (pred.deliverable_kind === ex.kind) kindOk++;
    if (!!pred.needs_clarify === !!ex.clarify) clarifyOk++;
  });
  const n = examples.length || 1;
  return {
    n,
    taskAcc: Number((taskOk / n).toFixed(4)),
    kindAcc: Number((kindOk / n).toFixed(4)),
    clarifyAcc: Number((clarifyOk / n).toFixed(4)),
  };
}

function main() {
  const args = process.argv.slice(2);
  const dataIdx = args.indexOf('--data');
  const extraPath = dataIdx >= 0 ? args[dataIdx + 1] : null;

  const rows = seedExamples()
    .concat(loadJsonl(SEED))
    .concat(extraPath ? loadJsonl(extraPath) : []);

  const examples = rows.map(toExample).filter(Boolean);
  // dedupe by message
  const seen = new Set();
  const unique = [];
  examples.forEach((ex) => {
    const k = ex.message.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    unique.push(ex);
  });

  if (unique.length < 10) {
    console.error('Need at least 10 labeled examples');
    process.exit(1);
  }

  // Persist seed for inspection / incremental labeling
  fs.mkdirSync(path.dirname(SEED), { recursive: true });
  fs.writeFileSync(
    SEED,
    unique
      .map((ex) =>
        JSON.stringify({
          message: ex.message,
          task_type: ex.task,
          deliverable_kind: ex.kind,
          needs_clarify: !!ex.clarify,
          source: ex.source,
        }),
      )
      .join('\n') + '\n',
  );

  const weights = train(unique.slice(), { epochs: 240, lr: 0.32, l2: 0.0015 });
  const artifact = {
    schema: 'chatre.understanding.classifier.v1',
    version: 1,
    trainedAt: new Date().toISOString(),
    featureNames: FEATURE_NAMES.slice(),
    taskTypes: TASK_TYPES.slice(),
    kindTypes: KIND_TYPES.slice(),
    taskWeights: weights.taskWeights,
    kindWeights: weights.kindWeights,
    clarifyWeights: weights.clarifyWeights,
    exampleCount: unique.length,
    metrics: null,
  };
  artifact.metrics = evaluate(unique, artifact);

  fs.mkdirSync(path.dirname(OUT_DATA), { recursive: true });
  fs.writeFileSync(OUT_DATA, JSON.stringify(artifact, null, 2));
  fs.writeFileSync(OUT_LIB, JSON.stringify(artifact, null, 2));
  Classifier.setArtifact(artifact);

  console.log('Wrote', OUT_LIB);
  console.log('Also wrote', OUT_DATA);
  console.log('Examples:', unique.length);
  console.log('Metrics:', artifact.metrics);
  if (artifact.metrics.taskAcc < 0.85 || artifact.metrics.kindAcc < 0.85) {
    console.warn('Warning: accuracy below 0.85 — add more labeled JSONL rows');
  }
}

main();
