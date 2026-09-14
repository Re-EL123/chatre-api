#!/usr/bin/env node
'use strict';

/**
 * Export understanding training rows from thread understandingLog JSON
 * (or stdin). No new API route.
 *
 * Usage:
 *   node scripts/export-understanding-dataset.js path/to/threads.jsonl >> data/understanding-extra.jsonl
 *   node scripts/export-understanding-dataset.js --from-eval >> data/understanding-extra.jsonl
 *
 * Thread JSONL row shape (flexible):
 *   { "understandingLog": [ { messagePreview, briefing, route, metrics, feedback } ] }
 *   or a single understanding record.
 */

const fs = require('fs');
const path = require('path');
const { normalizeBriefing } = require('../lib/analyst');

function rowFromRecord(rec, fallbackMessage) {
  if (!rec || typeof rec !== 'object') return null;
  const message =
    String(
      rec.message ||
        rec.userMessage ||
        rec.messagePreview ||
        fallbackMessage ||
        '',
    ).trim() || String(fallbackMessage || '').trim();
  if (!message) return null;
  const briefing = rec.briefing || {};
  const route = rec.route || {};
  const feedback = rec.feedback || null;

  let task =
    briefing.task_type || route.task_type || (rec.label && rec.label.task_type);
  let kind =
    briefing.deliverable_kind ||
    route.deliverable_kind ||
    (rec.label && rec.label.deliverable_kind);
  let clarify =
    briefing.needs_clarification != null
      ? !!briefing.needs_clarification
      : rec.clarifyAsked != null
        ? !!rec.clarifyAsked
        : null;

  // Outcome-based relabel: dismissed clarify → should not have clarified.
  if (feedback && feedback.kind === 'over_clarify') clarify = false;
  if (feedback && feedback.kind === 'under_clarify') clarify = true;

  // If still incomplete, fill from current normalizer (bootstrap labels).
  if (!task || !kind || clarify == null) {
    const b = normalizeBriefing(null, message);
    task = task || b.task_type;
    kind = kind || b.deliverable_kind;
    if (clarify == null) clarify = !!b.needs_clarification;
  }

  return {
    message,
    task_type: task,
    deliverable_kind: kind,
    needs_clarify: !!clarify,
    source: rec.source || 'understandingLog',
    runId: rec.runId || null,
    feedback: feedback || null,
  };
}

function exportFromEval() {
  const Understanding = require('../lib/understanding');
  const cases = [
    'hi',
    'build a calculator in html',
    'how do I sort an array in JavaScript?',
    'make me something cool',
    'why is my node script failing with EADDRINUSE?',
    'generate a pdf of the 42 laws of maat',
    'clone https://github.com/acme/demo and fix the failing tests',
  ];
  return cases.map((message) => {
    const b = normalizeBriefing(null, message);
    const route = Understanding.preLlmRoute(message);
    return rowFromRecord(
      {
        message,
        briefing: b,
        route,
        clarifyAsked: !!b.needs_clarification,
        source: 'eval-export',
      },
      message,
    );
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--from-eval') {
    exportFromEval().filter(Boolean).forEach((r) => console.log(JSON.stringify(r)));
    return;
  }
  const file = args[0];
  if (!file) {
    console.error(
      'Usage: node scripts/export-understanding-dataset.js <threads.jsonl|--from-eval>',
    );
    process.exit(1);
  }
  const abs = path.resolve(file);
  const lines = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean);
  let n = 0;
  lines.forEach((line) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const logs = Array.isArray(obj.understandingLog)
      ? obj.understandingLog
      : Array.isArray(obj)
        ? obj
        : [obj];
    logs.forEach((rec) => {
      const row = rowFromRecord(rec, obj.message || obj.title);
      if (!row) return;
      console.log(JSON.stringify(row));
      n++;
    });
  });
  console.error('exported', n, 'rows');
}

main();
