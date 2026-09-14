'use strict';

/**
 * Message-understanding precision: confidence gate, answer vs deliver,
 * soft done_when rejection, mode suggestions, and user corrections.
 */

const CONFIDENCE_THRESHOLD = 0.75;

const SOFT_DONE_PATTERNS = [
  /^user-visible goal completed/i,
  /^goal completed with workspace/i,
  /^deliverables exist and match/i,
  /^verify and summarize$/i,
  /^implement the work$/i,
  /^complete the (user )?request$/i,
  /^done$/i,
  /^finished$/i,
  /^success$/i,
  /^as requested$/i,
  /^task complete/i,
];

const VALID_TASK_TYPES = [
  'chat',
  'question',
  'research',
  'browser',
  'build',
  'debug',
  'document',
  'git',
  'run',
  'mixed',
];

function clamp01(n, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function asStringList(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === 'string') return x.trim();
      if (x && typeof x === 'object') {
        return String(x.text || x.content || x.message || '').trim();
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 12);
}

function isSoftDoneWhen(s) {
  const t = String(s || '').trim();
  if (!t || t.length < 8) return true;
  return SOFT_DONE_PATTERNS.some((re) => re.test(t));
}

/**
 * Soft keyword hint — never authoritative over a high-confidence analyst.
 */
function softTaskTypeHint(userMessage) {
  const msg = String(userMessage || '').toLowerCase();
  if (!msg.trim()) return null;

  const howToLead =
    /^(how\s+(do|to|can|should)|what\s+(is|are|does)|why\s+(is|does|do)|explain|describe|tell\s+me)\b/i.test(
      String(userMessage || '').trim(),
    );
  // Language/stack words alone are NOT build signals (e.g. "how do I sort in JavaScript?").
  const wantsAppOrSite =
    (!howToLead &&
      /\b(html|css|javascript|\.js\b|canvas|bubble.?shooter|game in html|website|web app|landing page|react|vue|svelte|frontend|vanilla)\b/.test(
        msg,
      ) &&
      /\b(create|make|build|design|scaffold|implement|write|fix|add)\b/.test(msg)) ||
    /\b(create|make|build|design|scaffold|implement|write)\b.{0,100}\b(game|app|website|page|project|calculator|widget|todo|todos|counter|clock|quiz|form|dashboard|ui)\b/.test(
      msg,
    ) ||
    /\b(calculator|todo\s*app|to-?do list|counter app|stopwatch|timer app|quiz app)\b/.test(
      msg,
    );
  const wantsCodeFix =
    !howToLead &&
    (/\b(implement|refactor|add|write)\b.{0,40}\b(auth|api|endpoint|module|component|function|class|test)\b/.test(
      msg,
    ) ||
      (/\b(python|typescript|node\.?js)\b/.test(msg) &&
        /\b(create|make|build|implement|fix|add|write)\b/.test(msg)));
  const wantsDebug =
    /\b(debug|fix|why.*(fail|error|broken)|stack\s*trace|reproduce)\b/.test(msg) ||
    /\b(fix|debug)\b.{0,40}\b(bug|error|crash|issue|fail)\b/.test(msg);
  const wantsOffice =
    /\b(xlsx|xls|csv|spreadsheet|excel|pptx|powerpoint|docx|word\s*doc|google\s*doc|google\s*sheet)\b/.test(
      msg,
    );
  const wantsDocOnly =
    (/\bpdf\b/.test(msg) ||
      /\b(generate|create|make|write)\b.{0,40}\b(book|report|guide|manual|essay|document|memo)\b/.test(
        msg,
      ) ||
      wantsOffice) &&
    !wantsAppOrSite &&
    !wantsCodeFix;
  const wantsResearch =
    /\b(research|investigate|look\s*up|sources?|cite)\b/.test(msg) &&
    !wantsAppOrSite &&
    !wantsDocOnly &&
    !wantsDebug;
  const wantsGit =
    /\b(git\s+(commit|push|pull|clone|status)|pull\s*request|create\s+pr|open\s+pr)\b/.test(
      msg,
    ) || /github\.com|gitlab\.com|bitbucket\.org/i.test(String(userMessage || ''));
  const wantsBrowse =
    /\b(browse|navigate|click|fill\s+(the\s+)?form|screenshot|dogfood)\b/.test(msg);

  if (wantsDebug && !wantsAppOrSite) return 'debug';
  if (wantsAppOrSite || wantsCodeFix) return 'build';
  if (wantsDocOnly) return 'document';
  if (wantsGit && !wantsAppOrSite) return 'git';
  if (wantsBrowse) return 'browser';
  if (wantsResearch) return 'research';
  if (/^\s*(hi|hello|hey|thanks|thank you)\b/.test(msg) && msg.length < 40) {
    return 'chat';
  }
  return null;
}

/**
 * Answer vs deliver — how-to / explain defaults to answer, not files.
 */
function classifyDeliverableKind(userMessage, taskType) {
  const msg = String(userMessage || '').trim();
  const lower = msg.toLowerCase();
  const t = String(taskType || '').toLowerCase();

  const howToLead =
    /^(how\s+(do|to|can|should)|what\s+(is|are|does)|why\s+(is|does|do)|explain|describe|tell\s+me|can\s+you\s+explain)\b/i.test(
      msg,
    ) ||
    /\b(how\s+(do|to|can)\s+i|what\s+does\s+.{0,40}\s+mean)\b/i.test(lower);

  const deliverVerb =
    /\b(build|create|make|implement|scaffold|generate|write|fix|patch|deploy|commit|push|clone|run|execute)\b/i.test(
      msg,
    );

  const wantsArtifact =
    /\b(pdf|spreadsheet|xlsx|csv|pptx|docx|html|app|website|landing\s*page|game|repo|pull\s*request)\b/i.test(
      lower,
    );

  if (t === 'chat') return 'answer';
  if (howToLead && !wantsArtifact && !/\b(for\s+me|into\s+(my|the)\s+workspace)\b/i.test(lower)) {
    return 'answer';
  }
  if (t === 'question' && !deliverVerb && !wantsArtifact) return 'answer';
  if (t === 'build' || t === 'document' || t === 'git' || t === 'run' || t === 'debug') {
    return 'deliver';
  }
  if (deliverVerb || wantsArtifact) return 'deliver';
  if (t === 'research' || t === 'browser') return 'mixed';
  return 'mixed';
}

function defaultConfidence(obj, unknowns) {
  const raw = clamp01(obj && (obj.confidence != null ? obj.confidence : obj.understanding_confidence), NaN);
  if (Number.isFinite(raw)) return raw;
  // Missing confidence: only treat as low when unknowns exist.
  if (unknowns && unknowns.length) return 0.55;
  return 0.82;
}

function buildClarificationQuestion(briefing, unknowns) {
  const existing = String(
    (briefing && (briefing.clarification_question || briefing.clarificationQuestion)) || '',
  ).trim();
  if (existing) return existing;
  const u = (unknowns || []).filter(Boolean);
  if (u.length === 1) {
    return 'Quick check before I proceed: ' + u[0] + '?';
  }
  if (u.length > 1) {
    return (
      'Before I proceed I need one detail: ' +
      u[0] +
      ' (also unclear: ' +
      u.slice(1, 3).join('; ') +
      ')'
    );
  }
  return 'Before I proceed — what should the concrete deliverable be (answer only, files in workspace, or both)?';
}

/**
 * Force clarify when confidence is low or unknowns remain.
 */
function applyUnderstandingGate(briefing, userMessage, opts) {
  const b = briefing && typeof briefing === 'object' ? briefing : {};
  const o = opts || {};
  const msg = String(userMessage || '').trim();
  const taskType = String(b.task_type || 'mixed').toLowerCase();

  if (o.skipGate || taskType === 'chat') {
    return b;
  }
  if (/^\s*(hi|hello|hey|thanks|thank you)\b/i.test(msg) && msg.length < 40) {
    b.needs_clarification = false;
    return b;
  }

  const assumptions = asStringList(b.assumptions);
  let unknowns = asStringList(b.unknowns);
  let confidence = defaultConfidence(b, unknowns);
  b.assumptions = assumptions;

  const kind = String(b.deliverable_kind || classifyDeliverableKind(msg, taskType));
  b.deliverable_kind = kind;

  const clearDeliver =
    (kind === 'deliver' ||
      taskType === 'build' ||
      taskType === 'document' ||
      taskType === 'debug' ||
      taskType === 'git') &&
    msg.length >= 20 &&
    (/\b(build|create|make|implement|write|scaffold|fix|add|patch|deploy|commit)\b/i.test(
      msg,
    ) ||
      (Array.isArray(b.files) && b.files.length > 0) ||
      (b.goal && String(b.goal).trim().length >= 12));

  if (kind === 'deliver' || taskType === 'build' || taskType === 'document') {
    const hasAcceptance =
      (Array.isArray(b.acceptance_tests) && b.acceptance_tests.length) ||
      (Array.isArray(b.success_criteria) && b.success_criteria.length);
    // Soft done_when is filled by deriveDoneWhen — do not invent a blocking unknown.
    if (isSoftDoneWhen(b.done_when) && !hasAcceptance) {
      confidence = Math.min(confidence, clearDeliver ? 0.8 : 0.68);
    }
    if (
      (!b.goal || String(b.goal).length < 8) &&
      !(Array.isArray(b.files) && b.files.length) &&
      !clearDeliver
    ) {
      if (unknowns.indexOf('what exact deliverable and where it should live') < 0) {
        unknowns.push('what exact deliverable and where it should live');
      }
      confidence = Math.min(confidence, 0.55);
    }
  }

  if (kind === 'answer' && (taskType === 'build' || taskType === 'document') && !clearDeliver) {
    if (
      unknowns.indexOf(
        'should I explain only, or also create files in the workspace',
      ) < 0
    ) {
      unknowns.push('should I explain only, or also create files in the workspace');
    }
    confidence = Math.min(confidence, 0.55);
  }

  // Drop auto-resolvable / soft unknowns so they never stall a clear build.
  const AUTO_RESOLVE_UNKNOWN = [
    'what "done" looks like (observable check)',
    'what done looks like',
  ];
  unknowns = asStringList(unknowns).filter((u) => {
    const low = String(u || '').toLowerCase();
    return !AUTO_RESOLVE_UNKNOWN.some(
      (p) => low === p || low.indexOf(p) >= 0 || p.indexOf(low) >= 0,
    );
  });
  b.unknowns = unknowns;
  b.confidence = confidence;

  const confidenceExplicit =
    b._confidenceExplicit === true ||
    (opts && opts.confidenceExplicit === true);
  // Only block on real gaps: explicit clarify flag, remaining unknowns, or
  // explicit low confidence when the request is not already a clear deliver.
  const mustClarify =
    (b.needs_clarification === true && !(clearDeliver && unknowns.length === 0)) ||
    unknowns.length > 0 ||
    (confidenceExplicit &&
      confidence < CONFIDENCE_THRESHOLD &&
      !clearDeliver);

  if (mustClarify) {
    b.needs_clarification = true;
    b.clarification_question = buildClarificationQuestion(b, b.unknowns);
  } else {
    b.needs_clarification = false;
    if (!String(b.clarification_question || '').trim()) {
      b.clarification_question = '';
    }
  }

  return b;
}

/**
 * Resolve task_type: analyst wins when confident; soft hint only otherwise.
 */
function resolveTaskType(analystType, userMessage, confidence) {
  let t = String(analystType || 'mixed').toLowerCase();
  if (VALID_TASK_TYPES.indexOf(t) < 0) t = 'mixed';
  const hint = softTaskTypeHint(userMessage);
  const conf = clamp01(confidence, 0.7);

  if (!hint) return t;

  if (conf >= CONFIDENCE_THRESHOLD) {
    const deliveryHint = ['build', 'document', 'debug', 'git', 'run'].indexOf(hint) >= 0;
    const weakAnalyst = t === 'mixed' || t === 'chat' || t === 'question';
    const howTo =
      /^(how\s+(do|to|can|should)|what\s+(is|are|does)|why\s+|explain\b)/i.test(
        String(userMessage || '').trim(),
      );
    // High-confidence analyst wins; only nudge mixed→delivery, never how-to questions.
    if (deliveryHint && t === 'mixed' && !howTo) return hint;
    if (deliveryHint && weakAnalyst && !howTo && t !== 'question' && t !== 'chat') {
      return hint;
    }
    return t;
  }

  if (t === 'mixed' || t === 'chat' || t === 'question' || t === 'research') {
    return hint;
  }
  return t;
}

/**
 * Soft mode suggestion — never forces composer mode.
 */
function suggestMode(briefing, composerMode) {
  const b = briefing || {};
  const current = String(composerMode || 'agent').toLowerCase() || 'agent';
  const t = String(b.task_type || 'mixed').toLowerCase();
  const kind = String(b.deliverable_kind || 'mixed').toLowerCase();

  let suggested = 'agent';
  let reason = 'General agent loop for this task type.';

  if (t === 'chat' || (kind === 'answer' && (t === 'question' || t === 'chat'))) {
    suggested = 'chat';
    reason =
      'Looks like a conversational / explain-only request — Chat avoids unnecessary tools.';
  } else if (t === 'browser' || /\bbrowse|navigate|fill\b/i.test(String(b.goal || ''))) {
    suggested = 'browse';
    reason = 'Browser interaction is central — Browse mode prioritizes navigation tools.';
  } else if (t === 'research' && kind !== 'deliver') {
    suggested = 'explore';
    reason =
      'Research/explore fits read-heavy investigation without mutating the product.';
  } else if (kind === 'deliver' && (t === 'build' || t === 'document' || t === 'debug')) {
    suggested = 'agent';
    reason = 'Workspace delivery (files/preview) fits Agent mode.';
  } else if (t === 'git' || t === 'run') {
    suggested = 'agent';
    reason = 'Git/run actions need the agent tool loop.';
  } else if (t === 'question' && kind === 'answer') {
    suggested = 'chat';
    reason =
      'Question can be answered directly; switch to Agent only if you want tools.';
  }

  return {
    suggested_mode: suggested,
    mode_reason: reason,
    mode_matches: suggested === current,
    current_mode: current,
  };
}

function formatIntentContract(briefing) {
  const b = briefing || {};
  const lines = [
    'You want: ' + (b.goal || b.understanding || '(unclear)'),
    'I will: ' +
      (b.deliverable_kind === 'answer'
        ? 'answer / explain (no workspace files unless you ask)'
        : b.deliverable_kind === 'deliver'
          ? 'deliver workspace artifacts'
          : 'mix of answer and tools as needed'),
    'Done when: ' +
      (isSoftDoneWhen(b.done_when) ? '(needs a concrete check)' : b.done_when),
  ];
  const assumptions = asStringList(b.assumptions);
  if (assumptions.length) {
    lines.push('I assumed: ' + assumptions.slice(0, 4).join('; '));
  }
  const unknowns = asStringList(b.unknowns);
  if (unknowns.length) {
    lines.push('Still unclear: ' + unknowns.slice(0, 4).join('; '));
  }
  if (b.confidence != null) {
    lines.push('Confidence: ' + Math.round(Number(b.confidence) * 100) + '%');
  }
  return lines.join('\n');
}

function mergeCorrections(briefing, corrections) {
  const b = briefing && typeof briefing === 'object' ? Object.assign({}, briefing) : {};
  const incoming = asStringList(corrections);
  const prev = asStringList(b.user_corrections);
  const merged = [];
  incoming.concat(prev).forEach((c) => {
    if (merged.indexOf(c) < 0) merged.push(c);
  });
  b.user_corrections = merged.slice(0, 16);
  if (merged.length) {
    const constraintLines = merged.map((c) => 'User correction: ' + c);
    b.constraints = asStringList(b.constraints)
      .concat(constraintLines)
      .filter((x, i, arr) => arr.indexOf(x) === i)
      .slice(0, 20);
  }
  return b;
}

function detectCorrectionMessage(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (
    /^(no[,.]?\s+|nope[,.]?\s+|not\s+what\s+i\s+meant|i\s+meant\b|actually\b|correction\b|rather\b|instead\b)/i.test(
      t,
    ) ||
    /\b(i\s+meant|not\s+that|wrong\s+—|wrong\s+-)\b/i.test(t)
  ) {
    return t.slice(0, 500);
  }
  return null;
}

function answerFirstDoNot(briefing) {
  const kind = String((briefing && briefing.deliverable_kind) || '');
  if (kind !== 'answer') return [];
  return [
    'Do not create workspace files unless the user explicitly asks for a file/app/PDF',
    'Do not run preview_project or mutate the repo for a pure explanation request',
    'Prefer a clear answer with optional short examples over scaffolding a project',
  ];
}

module.exports = {
  CONFIDENCE_THRESHOLD,
  SOFT_DONE_PATTERNS,
  isSoftDoneWhen,
  softTaskTypeHint,
  classifyDeliverableKind,
  applyUnderstandingGate,
  resolveTaskType,
  suggestMode,
  formatIntentContract,
  mergeCorrections,
  detectCorrectionMessage,
  answerFirstDoNot,
  asStringList,
  clamp01,
};
