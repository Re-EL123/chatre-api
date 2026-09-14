'use strict';

/**
 * Understanding classifier runtime — logistic/softmax heads over feature vectors.
 * Artifact: data/understanding-classifier.json (trained offline, no new API route).
 */

const fs = require('fs');
const path = require('path');
const {
  FEATURE_NAMES,
  TASK_TYPES,
  KIND_TYPES,
  extractFeatureVector,
} = require('./understanding-features');

let cachedArtifact = null;
let cacheTried = false;

function defaultArtifact() {
  return {
    schema: 'chatre.understanding.classifier.v1',
    version: 0,
    trainedAt: null,
    featureNames: FEATURE_NAMES.slice(),
    taskTypes: TASK_TYPES.slice(),
    kindTypes: KIND_TYPES.slice(),
    taskWeights: null,
    kindWeights: null,
    clarifyWeights: null,
    metrics: null,
  };
}

function loadArtifact(force) {
  if (cacheTried && !force) return cachedArtifact;
  cacheTried = true;
  const candidates = [
    path.join(__dirname, 'understanding-classifier.artifact.json'),
    path.join(__dirname, '..', 'data', 'understanding-classifier.json'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!raw || raw.schema !== 'chatre.understanding.classifier.v1') continue;
      cachedArtifact = raw;
      return cachedArtifact;
    } catch {
      /* try next */
    }
  }
  cachedArtifact = null;
  return null;
}

function setArtifact(art) {
  cachedArtifact = art || null;
  cacheTried = true;
}

function softmax(logits) {
  const max = Math.max.apply(null, logits);
  const exps = logits.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function dot(weights, feats) {
  let s = 0;
  const n = Math.min(weights.length, feats.length);
  for (let i = 0; i < n; i++) s += Number(weights[i] || 0) * Number(feats[i] || 0);
  return s;
}

function predictFromFeatures(feats, artifact) {
  const art = artifact || loadArtifact();
  if (!art || !art.taskWeights || !art.kindWeights || !art.clarifyWeights) {
    return null;
  }
  const taskLogits = art.taskWeights.map((w) => dot(w, feats));
  const taskProbs = softmax(taskLogits);
  let taskIdx = 0;
  let taskBest = -1;
  taskProbs.forEach((p, i) => {
    if (p > taskBest) {
      taskBest = p;
      taskIdx = i;
    }
  });

  const kindLogits = art.kindWeights.map((w) => dot(w, feats));
  const kindProbs = softmax(kindLogits);
  let kindIdx = 0;
  let kindBest = -1;
  kindProbs.forEach((p, i) => {
    if (p > kindBest) {
      kindBest = p;
      kindIdx = i;
    }
  });

  const clarifyScore = sigmoid(dot(art.clarifyWeights, feats));
  const taskType = (art.taskTypes || TASK_TYPES)[taskIdx] || 'mixed';
  const deliverableKind = (art.kindTypes || KIND_TYPES)[kindIdx] || 'mixed';
  const confidence = Number(Math.max(taskBest, kindBest).toFixed(4));

  const scores = {};
  (art.taskTypes || TASK_TYPES).forEach((t, i) => {
    scores[t] = Number(taskProbs[i].toFixed(4));
  });

  return {
    source: 'classifier',
    task_type: taskType,
    deliverable_kind: deliverableKind,
    needs_clarify: clarifyScore >= 0.55,
    clarify_prob: Number(clarifyScore.toFixed(4)),
    confidence,
    scores,
    kind_scores: (art.kindTypes || KIND_TYPES).reduce((acc, k, i) => {
      acc[k] = Number(kindProbs[i].toFixed(4));
      return acc;
    }, {}),
    version: art.version || 0,
  };
}

function predict(userMessage, opts) {
  const o = opts || {};
  const Understanding = require('./understanding');
  const signals = o.signals || Understanding.extractIntentSignals(userMessage);
  const feats = extractFeatureVector(userMessage, signals, {
    isProceedDirective: Understanding.isProceedDirective,
    isWorkspaceDirective: Understanding.isWorkspaceDirective,
    isRepoDirective: Understanding.isRepoDirective,
  });
  return predictFromFeatures(feats, o.artifact || loadArtifact());
}

/**
 * Blend heuristic scoreRouter with classifier when the model is confident.
 */
function blendRouter(heuristic, classification) {
  if (!classification || classification.confidence < 0.62) {
    return heuristic;
  }
  const scores = Object.assign({}, heuristic.scores || {});
  const clfScores = classification.scores || {};
  Object.keys(clfScores).forEach((k) => {
    const h = Number(scores[k] || 0);
    const c = Number(clfScores[k] || 0);
    // Weighted blend — classifier dominates when confident.
    const w = Math.min(0.85, classification.confidence);
    scores[k] = h * (1 - w) + c * w * 1.2;
  });

  let top = heuristic.top || 'mixed';
  let best = -1;
  Object.keys(scores).forEach((k) => {
    if (scores[k] > best) {
      best = scores[k];
      top = k;
    }
  });

  // High-confidence classifier can override top when heuristic is weak/mixed.
  if (
    classification.confidence >= 0.78 &&
    (heuristic.top === 'mixed' ||
      heuristic.confidence < 0.7 ||
      classification.confidence > heuristic.confidence + 0.08)
  ) {
    top = classification.task_type;
    best = Math.max(best, classification.confidence);
  }

  return {
    top,
    scores,
    confidence: Number(
      Math.max(0.35, Math.min(0.97, Math.max(best, classification.confidence))).toFixed(3),
    ),
    signals: heuristic.signals,
    classifier: {
      task_type: classification.task_type,
      deliverable_kind: classification.deliverable_kind,
      needs_clarify: classification.needs_clarify,
      clarify_prob: classification.clarify_prob,
      confidence: classification.confidence,
      version: classification.version,
    },
  };
}

module.exports = {
  defaultArtifact,
  loadArtifact,
  setArtifact,
  predict,
  predictFromFeatures,
  blendRouter,
  FEATURE_NAMES,
  TASK_TYPES,
  KIND_TYPES,
};
