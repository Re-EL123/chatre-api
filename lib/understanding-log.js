'use strict';

/**
 * Understanding outcome log — fold into existing thread / agentRun writes.
 * No new serverless routes.
 */

const Understanding = require('./understanding');

const MAX_LOG = 40;

function buildUnderstandingRecord(input) {
  const i = input && typeof input === 'object' ? input : {};
  const briefing = i.briefing || {};
  const msg = String(i.userMessage || '');
  const signals = i.signals || Understanding.extractIntentSignals(msg);
  const route = i.route || Understanding.preLlmRoute(msg);
  const router = i.routerScore || Understanding.scoreRouter(msg);
  const outcome = String(i.outcome || 'analyzed');
  const clarifyAsked = !!(
    briefing.needs_clarification && briefing.clarification_question
  );

  return {
    schema: 'chatre.understanding.v1',
    at: new Date().toISOString(),
    runId: i.runId || null,
    messageHash: hashMessage(msg),
    messagePreview: msg.slice(0, 160),
    route: {
      task_type: route.task_type || null,
      deliverable_kind: route.deliverable_kind || null,
      confidence: route.confidence != null ? route.confidence : null,
      reason: route.reason || null,
      skipAnalyst: !!route.skipAnalyst,
      files: Array.isArray(route.files) ? route.files.slice(0, 4) : [],
    },
    router: {
      top: router.top || null,
      scores: router.scores || {},
      confidence: router.confidence != null ? router.confidence : null,
    },
    briefing: {
      task_type: briefing.task_type || null,
      deliverable_kind: briefing.deliverable_kind || null,
      confidence: briefing.confidence != null ? Number(briefing.confidence) : null,
      needs_clarification: !!briefing.needs_clarification,
      clarification_question: String(briefing.clarification_question || '').slice(
        0,
        240,
      ),
      blocking_unknowns: Understanding.asStringList(briefing.blocking_unknowns).slice(
        0,
        6,
      ),
      files: Array.isArray(briefing.files)
        ? briefing.files.map(String).slice(0, 6)
        : [],
      done_when: String(briefing.done_when || '').slice(0, 200),
      user_corrections: Understanding.asStringList(briefing.user_corrections).slice(
        0,
        8,
      ),
      suggested_mode: briefing.suggested_mode || null,
      minimal_single_file: !!briefing.minimal_single_file,
    },
    signals: {
      howToLead: !!signals.howToLead,
      deliverVerb: !!signals.deliverVerb,
      wantsArtifact: !!signals.wantsArtifact,
      wantsDebug: !!signals.wantsDebug,
      wantsBrowse: !!signals.wantsBrowse,
      multiIntent: !!signals.multiIntent,
      absoluteFiles: (signals.absoluteFiles || []).slice(0, 4),
    },
    outcome,
    clarifyAsked,
    metrics: scoreClarifyMetrics({
      clarifyAsked,
      outcome,
      briefing,
      signals,
      feedback: i.feedback || null,
    }),
    feedback: i.feedback || null,
  };
}

function scoreClarifyMetrics(opts) {
  const o = opts || {};
  const briefing = o.briefing || {};
  const signals = o.signals || {};
  const feedback = o.feedback || null;
  let overClarifyRisk = 0;
  let underClarifyRisk = 0;

  if (o.clarifyAsked) {
    const clearish =
      signals.absoluteFiles &&
      signals.absoluteFiles.length &&
      (signals.deliverVerb || signals.wantsArtifact);
    if (clearish) overClarifyRisk = 0.7;
    if (Number(briefing.confidence) >= 0.8 && !(briefing.blocking_unknowns || []).length) {
      overClarifyRisk = Math.max(overClarifyRisk, 0.55);
    }
  } else if (
    (briefing.deliverable_kind === 'mixed' || briefing.task_type === 'mixed') &&
    signals.deliverVerb &&
    !signals.wantsArtifact &&
    !(signals.absoluteFiles || []).length
  ) {
    underClarifyRisk = 0.65;
  }

  if (feedback) {
    if (feedback.kind === 'over_clarify' || feedback.dismissed) overClarifyRisk = 1;
    if (feedback.kind === 'under_clarify' || feedback.neededClarify) {
      underClarifyRisk = 1;
    }
  }

  return {
    overClarifyRisk: Number(overClarifyRisk.toFixed(2)),
    underClarifyRisk: Number(underClarifyRisk.toFixed(2)),
  };
}

function appendToLog(existing, record) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  list.push(record);
  while (list.length > MAX_LOG) list.shift();
  return list;
}

function summarizeUnderstandingLog(log) {
  const list = Array.isArray(log) ? log : [];
  const clarify = list.filter((r) => r && r.clarifyAsked).length;
  const over = list.filter(
    (r) => r && r.metrics && Number(r.metrics.overClarifyRisk) >= 0.7,
  ).length;
  const under = list.filter(
    (r) => r && r.metrics && Number(r.metrics.underClarifyRisk) >= 0.65,
  ).length;
  const corrections = list.filter(
    (r) =>
      r &&
      r.briefing &&
      Array.isArray(r.briefing.user_corrections) &&
      r.briefing.user_corrections.length,
  ).length;
  const byType = {};
  list.forEach((r) => {
    const t =
      (r && r.briefing && r.briefing.task_type) ||
      (r && r.route && r.route.task_type) ||
      'unknown';
    byType[t] = (byType[t] || 0) + 1;
  });
  return {
    schema: 'chatre.understanding.summary.v1',
    count: list.length,
    clarifyAsked: clarify,
    overClarifySuspects: over,
    underClarifySuspects: under,
    withCorrections: corrections,
    byTaskType: byType,
  };
}

function detectClarifyFeedback(text) {
  return Understanding.detectClarifyFeedback(text);
}

function hashMessage(msg) {
  const s = String(msg || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return 'm' + (h >>> 0).toString(16);
}

module.exports = {
  MAX_LOG,
  buildUnderstandingRecord,
  scoreClarifyMetrics,
  appendToLog,
  summarizeUnderstandingLog,
  detectClarifyFeedback,
  hashMessage,
};
