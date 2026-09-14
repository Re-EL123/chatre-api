'use strict';

/**
 * Message-understanding precision: extractors, pre-LLM router, schema,
 * blocking-slot clarify gate, done_when compiler, mode suggestions.
 * Single source of truth for API (+ mirrored in chatre1/public/understanding.js).
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

const VALID_KINDS = ['answer', 'deliver', 'mixed'];

const NON_BLOCKING_UNKNOWN_RE = [
  /tone|style|voice|personality|brand(ing)?|color|theme|font/i,
  /audience|persona|target\s*user/i,
  /visual\s*design|look\s*and\s*feel|polish|aesthetic/i,
  /what\s*["']?done["']?\s*looks\s*like/i,
  /observable\s*check/i,
  /naming|slug\s*preference/i,
  /optional\s*(extra|feature)/i,
];

const BLOCKING_UNKNOWN_RE = [
  /deliverable|what\s+to\s+(build|create|make|write)|kind\s+of\s+(file|app|doc)/i,
  /where\s+(it|the\s+file|files?)\s+(should\s+)?live|target\s+path|which\s+path/i,
  /explain\s+only|create\s+files|answer\s+or\s+deliver/i,
  /stack|framework|language\s+to\s+use/i,
  /pdf\s+or\s+markdown|format\s+of\s+(the\s+)?(doc|report)/i,
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

function isHowToQuestion(userMessage) {
  const msg = String(userMessage || '').trim();
  return (
    /^(how\s+(do|to|can|should)|what\s+(is|are|does)|why\s+(is|does|do)|explain|describe|tell\s+me|can\s+you\s+explain)\b/i.test(
      msg,
    ) || /\b(how\s+(do|to|can)\s+i|what\s+does\s+.{0,40}\s+mean)\b/i.test(msg)
  );
}

/**
 * Deterministic path / format / intent extractors (before or beside the LLM).
 */
function extractPaths(text) {
  const src = String(text || '');
  const out = [];
  const seen = new Set();
  const re =
    /\/home\/user\/(?:projects|documents|downloads)\/[A-Za-z0-9._/-]+/g;
  let m;
  while ((m = re.exec(src))) {
    let p = m[0].replace(/[.,;:!?)\]}'"`]+$/, '');
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.slice(0, 8);
}

function extractIntentSignals(userMessage) {
  const msg = String(userMessage || '').trim();
  const lower = msg.toLowerCase();
  const paths = extractPaths(msg);
  const projectFiles = paths.filter((p) => p.indexOf('/home/user/projects/') === 0);
  const docFiles = paths.filter((p) => p.indexOf('/home/user/documents/') === 0);
  const absoluteFiles = paths.filter((p) => /\.[A-Za-z0-9]{1,8}$/.test(p));
  const howToLead = isHowToQuestion(msg);
  const greeting =
    /^\s*(hi|hello|hey|thanks|thank you|yo|sup)\b/i.test(msg) && msg.length < 40;
  const deliverVerb =
    /\b(build|buld|bulid|create|creat|make|implement|scaffold|generate|write|fix|patch|deploy|commit|push|clone|run|execute)\b/i.test(
      msg,
    );
  const wantsArtifact =
    /\b(pdf|spreadsheet|xlsx|csv|pptx|docx|html|app|website|landing\s*page|game|repo|pull\s*request|index\.html)\b/i.test(
      lower,
    ) || absoluteFiles.length > 0;
  const minimalSingleFile =
    !/\b(game|shooter|calculator|dashboard|todo\s*app)\b/i.test(lower) &&
    (/\b(write only|only that file|just (an? )?h1|hello[\s-]?world|one[\s-]?page|single[\s-]?file|minimal|tiny)\b/i.test(
      msg,
    ) ||
      (absoluteFiles.length === 1 &&
        /\.html?\b/i.test(absoluteFiles[0]) &&
        !/\b(style\.css|script\.js|game\.js)\b/i.test(lower)));
  const wantsPdf = /\bpdf\b/i.test(lower);
  const wantsCsv =
    /\b(xlsx|xls|csv|spreadsheet|excel)\b/i.test(lower);
  const wantsHtml =
    /\b(html|css|javascript|\.js\b|website|web app|landing page|canvas|frontend)\b/i.test(
      lower,
    ) || absoluteFiles.some((p) => /\.html?\b/i.test(p));
  const gitUrl = /github\.com|gitlab\.com|bitbucket\.org|\bgit\s+clone\b/i.test(
    msg,
  );
  const wantsDebug =
    /\b(debug|fix|reproduce|stack\s*trace)\b/i.test(lower) ||
    /\bwhy\b[\s\S]{0,80}\b(fail(?:ing|ed|s)?|error|broken|crash(?:ing|ed)?|eaddrinuse|enoent|segfault)\b/i.test(
      lower,
    );
  const wantsBrowse =
    /\b(browse|navigate|click|screenshot|dogfood)\b/i.test(lower) ||
    /\bfill\b[\s\S]{0,40}\bform\b/i.test(lower) ||
    /\bopen\s+https?:\/\//i.test(lower);
  const wantsResearch =
    /\b(research|investigate|look\s*up|sources?|cite)\b/i.test(lower) &&
    !wantsArtifact;
  const wantsGit =
    /\b(git\s+(commit|push|pull|clone|status)|pull\s*request|create\s+pr|open\s+pr)\b/i.test(
      lower,
    ) || gitUrl;
  const projectSlug =
    projectFiles.length > 0
      ? (projectFiles[0].match(/^\/home\/user\/projects\/([^/]+)/) || [])[1] ||
        null
      : null;
  const multiIntent =
    /\b(explain|describe|tell\s+me|answer)\b[\s\S]{0,60}\b(then|and\s+then|after\s+that|afterwards)\b[\s\S]{0,80}\b(build|create|make|write|implement|generate)\b/i.test(
      msg,
    ) ||
    /\b(build|create|make|write|implement)\b[\s\S]{0,80}\b(then|and\s+then|after\s+that)\b[\s\S]{0,60}\b(explain|describe|tell\s+me)\b/i.test(
      msg,
    ) ||
    (howToLead &&
      deliverVerb &&
      wantsArtifact &&
      /\b(and|then|also)\b/i.test(lower));
  const answerOnly =
    /\b(just\s+answer|answer\s+only|don't\s+create\s+(any\s+)?files|do\s+not\s+create\s+files|no\s+files|explain\s+only)\b/i.test(
      lower,
    );

  return {
    raw: msg,
    lower,
    howToLead,
    greeting,
    deliverVerb,
    wantsArtifact,
    minimalSingleFile,
    wantsPdf,
    wantsCsv,
    wantsHtml,
    wantsDebug,
    wantsBrowse,
    wantsResearch,
    wantsGit,
    gitUrl,
    paths,
    projectFiles,
    docFiles,
    absoluteFiles,
    projectSlug,
    multiIntent,
    answerOnly,
  };
}

/** Short user replies that mean "stop asking, proceed with defaults". */
function isProceedDirective(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 220) return false;
  return (
    /\b(you (decide|recommend|pick|choose)|your (call|recommendation)|implement.*(fully|yourself)|do it (fully|yourself)|just (build|do|make|implement|create)( it)?|go ahead|ship it|defaults? are fine|however you (want|recommend)|way you recommend)\b/i.test(
      t,
    ) ||
    /^(fully|please proceed|proceed|continue|yes[,.]?\s*(please|do it)?|ok(ay)?[,.]?\s*(do it|build it|go)?)$/i.test(
      t,
    )
  );
}

function isWorkspaceDirective(text) {
  const t = String(text || '').trim();
  return (
    t.length > 0 &&
    t.length < 120 &&
    /\b(in (the )?workspace|into (the )?workspace|save (it )?there|under \/home\/user|in (my )?projects)\b/i.test(
      t,
    )
  );
}

function isRepoDirective(text) {
  const t = String(text || '').trim();
  return (
    t.length > 0 &&
    t.length < 160 &&
    /\b(it should be a repo|as a repo|make (it )?a repo|git repo|project repo)\b/i.test(
      t,
    )
  );
}

function guessProjectSlug(lower) {
  const m = String(lower || '').match(
    /\b(calculator|todo|todos|counter|stopwatch|timer|quiz|clock|dashboard|landing|portfolio|chat|game|shooter|snake|tetris|weather|notes?|kanban|calendar)\b/i,
  );
  if (m) {
    const s = m[1].toLowerCase();
    if (s === 'todos') return 'todo';
    if (s === 'notes') return 'notes';
    return s;
  }
  return null;
}

/**
 * Assume a concrete project path so we do not ask "where should it live?"
 * for clear HTML/app asks.
 */
function inferDefaultFiles(userMessage, signals) {
  const sig = signals || extractIntentSignals(userMessage);
  if (sig.absoluteFiles && sig.absoluteFiles.length) {
    return sig.absoluteFiles.slice(0, 6);
  }
  if (sig.answerOnly || sig.howToLead || sig.greeting) return [];
  if (!(sig.deliverVerb || softTaskTypeHint(userMessage) === 'build' || softTaskTypeHint(userMessage) === 'document')) {
    // Still allow known app nouns without a clean verb (typos / shorthand).
    if (!/\b(calculator|todo\s*app|quiz|stopwatch|timer app)\b/i.test(sig.lower)) {
      return [];
    }
  }
  if (sig.wantsPdf) {
    const slug = guessProjectSlug(sig.lower) || 'document';
    return ['/home/user/documents/' + slug + '.pdf'];
  }
  if (sig.wantsCsv) {
    const slug = guessProjectSlug(sig.lower) || 'data';
    return ['/home/user/documents/' + slug + '.csv'];
  }
  // Bare "an app" without HTML/format/noun stays vague — do not invent a path.
  const knownNoun = guessProjectSlug(sig.lower);
  if (
    /\b(app|application|something(\s+cool)?)\b/i.test(sig.lower) &&
    !sig.wantsHtml &&
    !knownNoun &&
    !/\b(website|landing|page|game)\b/i.test(sig.lower)
  ) {
    return [];
  }
  if (sig.wantsHtml || knownNoun || /\b(website|landing\s*page|game)\b/i.test(sig.lower)) {
    const slug = sig.projectSlug || knownNoun || 'app';
    return ['/home/user/projects/' + slug + '/index.html'];
  }
  return [];
}

/**
 * Expand short follow-ups using the last concrete user ask in history.
 */
function expandFollowUpMessage(userMessage, history) {
  const msg = String(userMessage || '').trim();
  if (!msg) return msg;
  const follow =
    isProceedDirective(msg) ||
    isWorkspaceDirective(msg) ||
    isRepoDirective(msg) ||
    (msg.length < 80 &&
      /^(in the workspace|a repo|as a repo|the workspace|projects?)$/i.test(msg));
  if (!follow) return msg;
  const hist = Array.isArray(history) ? history : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (!m || m.role !== 'user') continue;
    const prior = String(m.content || '').trim();
    if (!prior || prior === msg) continue;
    const priorSignals = extractIntentSignals(prior);
    const priorHint = softTaskTypeHint(prior);
    if (
      priorSignals.deliverVerb ||
      priorSignals.wantsArtifact ||
      priorHint === 'build' ||
      priorHint === 'document' ||
      priorHint === 'debug' ||
      /\b(calculator|html|app|pdf|repo)\b/i.test(prior)
    ) {
      const extras = [];
      if (isWorkspaceDirective(msg) || isProceedDirective(msg)) {
        extras.push(
          'Save under /home/user/projects/ (pick a sensible slug) and implement fully — do not ask where to save.',
        );
      }
      if (isRepoDirective(msg)) {
        extras.push(
          'Treat it as a small project repo under /home/user/projects/<slug>/ with index.html (+ minimal supporting files only if needed).',
        );
      }
      if (isProceedDirective(msg)) {
        extras.push('Use your recommended structure. No further clarification.');
      }
      return (
        prior +
        '\n\nUser follow-up: ' +
        msg +
        (extras.length ? '\n' + extras.join(' ') : '')
      );
    }
  }
  // No prior concrete ask — keep the message; gate will skip clarify on proceed directives.
  return msg;
}

/**
 * Soft keyword hint — never authoritative over a high-confidence analyst.
 */
function softTaskTypeHint(userMessage) {
  const signals = extractIntentSignals(userMessage);
  const msg = signals.lower;
  if (!msg.trim()) return null;

  const wantsAppOrSite =
    (!signals.howToLead &&
      signals.wantsHtml &&
      /\b(create|creat|make|build|buld|bulid|design|scaffold|implement|write|fix|add)\b/.test(
        msg,
      )) ||
    /\b(create|creat|make|build|buld|bulid|design|scaffold|implement|write)\b.{0,100}\b(game|app|website|page|project|calculator|widget|todo|todos|counter|clock|quiz|form|dashboard|ui)\b/.test(
      msg,
    ) ||
    /\b(calculator|todo\s*app|to-?do list|counter app|stopwatch|timer app|quiz app)\b/.test(
      msg,
    );
  const wantsCodeFix =
    !signals.howToLead &&
    (/\b(implement|refactor|add|write)\b.{0,40}\b(auth|api|endpoint|module|component|function|class|test)\b/.test(
      msg,
    ) ||
      (/\b(python|typescript|node\.?js)\b/.test(msg) &&
        /\b(create|make|build|implement|fix|add|write)\b/.test(msg)));
  const wantsDocOnly =
    (signals.wantsPdf ||
      /\b(generate|create|make|write)\b.{0,40}\b(book|report|guide|manual|essay|document|memo)\b/.test(
        msg,
      ) ||
      signals.wantsCsv) &&
    !wantsAppOrSite &&
    !wantsCodeFix;

  // Remote repo + implementation work is build (clone/fix/README), not pure git/debug.
  if (
    signals.gitUrl &&
    /\b(fix|add|implement|readme|test|build|create|make|clone)\b/i.test(signals.lower)
  ) {
    return 'build';
  }
  if (signals.wantsDebug && !wantsAppOrSite && !signals.gitUrl) return 'debug';
  if (wantsAppOrSite || wantsCodeFix || signals.absoluteFiles.some((p) => /\/projects\//.test(p))) {
    return 'build';
  }
  if (wantsDocOnly) return 'document';
  if (signals.wantsBrowse || /\bscreenshot\b/i.test(signals.lower)) {
    return 'browser';
  }
  if (/\b(run\s+(the\s+)?(unit\s+)?tests?|npm\s+test|pytest)\b/i.test(signals.lower)) {
    return 'run';
  }
  if (
    (signals.wantsResearch ||
      (/\b(look\s*up|cite|sources?)\b/i.test(signals.lower) && !wantsAppOrSite)) &&
    !/\b(save|write|create|markdown|notes\.md|document)\b/i.test(signals.lower)
  ) {
    return 'research';
  }
  if (
    /\b(save|write|create)\b/i.test(signals.lower) &&
    /\b(notes?|markdown|doc|document|pdf)\b/i.test(signals.lower)
  ) {
    return 'document';
  }
  if (signals.wantsGit && !wantsAppOrSite) return 'git';
  if (signals.greeting) return 'chat';
  if (signals.howToLead && !signals.wantsArtifact) return 'question';
  // Ultra-short acknowledgements
  if (msg.length <= 4 && /^(ok|k|yes|no|yep|nope|sup)$/i.test(msg.trim())) {
    return 'chat';
  }
  return null;
}

function classifyDeliverableKind(userMessage, taskType) {
  const signals = extractIntentSignals(userMessage);
  const t = String(taskType || '').toLowerCase();

  if (t === 'chat' || signals.greeting) return 'answer';
  if (
    signals.howToLead &&
    !signals.wantsArtifact &&
    !/\b(for\s+me|into\s+(my|the)\s+workspace)\b/i.test(signals.lower)
  ) {
    return 'answer';
  }
  if (t === 'question' && !signals.deliverVerb && !signals.wantsArtifact) {
    return 'answer';
  }
  if (
    t === 'build' ||
    t === 'document' ||
    t === 'git' ||
    t === 'run' ||
    t === 'debug'
  ) {
    return 'deliver';
  }
  if (signals.deliverVerb || signals.wantsArtifact) return 'deliver';
  if (
    /\b(save|write|create)\b/i.test(signals.lower) &&
    /\b(notes?|markdown|doc|document|pdf|file)\b/i.test(signals.lower)
  ) {
    return 'deliver';
  }
  if (t === 'research' || t === 'browser') return 'mixed';
  return 'mixed';
}

/**
 * Cheap pre-LLM router — high-confidence shortcuts before analyst spend.
 */
function preLlmRoute(userMessage) {
  const signals = extractIntentSignals(userMessage);
  if (
    signals.greeting ||
    (signals.raw.length <= 4 && /^(ok|k|yes|no|yep|nope|sup)$/i.test(signals.raw))
  ) {
    return {
      skipAnalyst: true,
      task_type: 'chat',
      deliverable_kind: 'answer',
      suggested_mode: 'chat',
      confidence: 0.95,
      files: [],
      reason: 'short greeting',
    };
  }
  if (signals.answerOnly && !signals.absoluteFiles.length) {
    return {
      skipAnalyst: false,
      task_type: signals.howToLead ? 'question' : 'chat',
      deliverable_kind: 'answer',
      suggested_mode: 'chat',
      confidence: 0.9,
      files: [],
      reason: 'explicit answer-only',
    };
  }
  if (signals.multiIntent && (signals.deliverVerb || signals.wantsArtifact)) {
    const task =
      softTaskTypeHint(userMessage) ||
      (signals.wantsPdf || signals.wantsCsv ? 'document' : 'build');
    return {
      skipAnalyst: false,
      task_type: task === 'chat' || task === 'question' ? 'build' : task,
      deliverable_kind: 'deliver',
      suggested_mode: 'agent',
      confidence: 0.88,
      files: signals.absoluteFiles.slice(),
      reason: 'multi-intent explain+deliver → deliver',
    };
  }
  if (signals.wantsDebug && !signals.gitUrl) {
    return {
      skipAnalyst: false,
      task_type: 'debug',
      deliverable_kind: 'deliver',
      suggested_mode: 'agent',
      confidence: 0.9,
      files: [],
      reason: 'debug / failure diagnosis',
    };
  }
  if (signals.howToLead && !signals.wantsArtifact && !signals.deliverVerb && !signals.wantsDebug) {
    return {
      skipAnalyst: false,
      task_type: 'question',
      deliverable_kind: 'answer',
      suggested_mode: 'chat',
      confidence: 0.88,
      files: [],
      reason: 'how-to / explain without artifact',
    };
  }
  if (signals.absoluteFiles.length || (signals.deliverVerb && signals.wantsArtifact)) {
    const task =
      softTaskTypeHint(userMessage) ||
      (signals.wantsPdf || signals.wantsCsv ? 'document' : 'build');
    return {
      skipAnalyst: false,
      task_type: task === 'chat' || task === 'question' ? 'build' : task,
      deliverable_kind: 'deliver',
      suggested_mode: 'agent',
      confidence: signals.absoluteFiles.length ? 0.9 : 0.82,
      files: signals.absoluteFiles.length
        ? signals.absoluteFiles.slice()
        : signals.projectFiles.slice(),
      reason: 'imperative artifact / explicit path',
      minimalSingleFile: signals.minimalSingleFile,
    };
  }
  if (signals.gitUrl) {
    return {
      skipAnalyst: false,
      task_type: 'build',
      deliverable_kind: 'deliver',
      suggested_mode: 'agent',
      confidence: 0.86,
      files: [],
      reason: 'remote git url',
    };
  }

  // Classifier fill-in when keyword route is inconclusive.
  try {
    const hint = softTaskTypeHint(userMessage);
    const scored = scoreRouter(userMessage);
    if (
      scored &&
      scored.classifier &&
      scored.classifier.confidence >= 0.8 &&
      scored.top &&
      scored.top !== 'mixed'
    ) {
      // Prefer soft document/debug hints over a build-biased classifier.
      let task = scored.top;
      if (hint === 'document' || hint === 'debug' || hint === 'git' || hint === 'browser') {
        task = hint;
      }
      const kind =
        scored.classifier.deliverable_kind ||
        (['question', 'chat', 'research'].indexOf(task) >= 0
          ? 'answer'
          : 'deliver');
      return {
        skipAnalyst: false,
        task_type: task,
        deliverable_kind: kind,
        suggested_mode:
          kind === 'answer' || task === 'chat' || task === 'question'
            ? 'chat'
            : task === 'browser'
              ? 'browse'
              : 'agent',
        confidence: scored.confidence,
        files: inferDefaultFiles(userMessage, signals),
        reason: hint && hint !== scored.top ? 'classifier+soft-hint' : 'understanding-classifier',
        needs_clarify: !!scored.classifier.needs_clarify,
      };
    }
  } catch (e) {
    /* optional */
  }

  return {
    skipAnalyst: false,
    task_type: softTaskTypeHint(userMessage) || null,
    deliverable_kind: null,
    suggested_mode: null,
    confidence: null,
    files: signals.absoluteFiles.slice(),
    reason: 'needs analyst',
  };
}

function enrichFromSignals(briefing, userMessage) {
  const b = briefing && typeof briefing === 'object' ? briefing : {};
  const signals = extractIntentSignals(userMessage);
  const route = preLlmRoute(userMessage);

  if ((!Array.isArray(b.files) || !b.files.length) && route.files && route.files.length) {
    b.files = route.files.slice();
  }
  if ((!Array.isArray(b.files) || !b.files.length) && signals.absoluteFiles.length) {
    b.files = signals.absoluteFiles.slice();
  }
  if ((!Array.isArray(b.files) || !b.files.length)) {
    const inferred = inferDefaultFiles(userMessage, signals);
    if (inferred.length) {
      b.files = inferred;
      b.assumptions = asStringList(b.assumptions);
      const assume =
        'Assumed deliverable path: ' + inferred[0] + ' (user can correct)';
      if (b.assumptions.indexOf(assume) < 0) b.assumptions.push(assume);
    }
  }
  if (isRepoDirective(userMessage) || /\bas a repo\b|\brepo\b/i.test(signals.lower)) {
    b.assumptions = asStringList(b.assumptions);
    if (b.assumptions.indexOf('Deliver as a small project folder (repo-like) under /home/user/projects/') < 0) {
      b.assumptions.push(
        'Deliver as a small project folder (repo-like) under /home/user/projects/',
      );
    }
    if (!b.task_type || b.task_type === 'mixed' || b.task_type === 'chat') {
      b.task_type = 'build';
    }
    b.deliverable_kind = 'deliver';
  }
  if (isProceedDirective(userMessage) || isWorkspaceDirective(userMessage)) {
    b.needs_clarification = false;
    b.clarification_question = '';
    b.blocking_unknowns = [];
    if (!b.task_type || b.task_type === 'mixed') b.task_type = 'build';
    if (!b.deliverable_kind || b.deliverable_kind === 'mixed') {
      b.deliverable_kind = 'deliver';
    }
    b.confidence = Math.max(clamp01(b.confidence, 0.7), 0.86);
  }
  if (signals.minimalSingleFile) {
    b.minimal_single_file = true;
    b.assumptions = asStringList(b.assumptions);
    if (
      b.assumptions.indexOf('minimal single-file deliverable (no extra assets)') < 0
    ) {
      b.assumptions.push('minimal single-file deliverable (no extra assets)');
    }
  }
  if (
    (!b.task_type || b.task_type === 'mixed') &&
    route.task_type &&
    route.confidence >= 0.82
  ) {
    b.task_type = route.task_type;
  }
  if (
    (!b.deliverable_kind || b.deliverable_kind === 'mixed') &&
    route.deliverable_kind &&
    route.confidence >= 0.82
  ) {
    b.deliverable_kind = route.deliverable_kind;
  }
  return b;
}

function validateBriefingSchema(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const errors = [];
  const taskType = String(o.task_type || o.taskType || '').toLowerCase();
  const kind = String(o.deliverable_kind || o.deliverableKind || '').toLowerCase();
  if (taskType && VALID_TASK_TYPES.indexOf(taskType) < 0) {
    errors.push('invalid task_type');
  }
  if (kind && VALID_KINDS.indexOf(kind) < 0) {
    errors.push('invalid deliverable_kind');
  }
  const confidence = clamp01(
    o.confidence != null ? o.confidence : o.understanding_confidence,
    NaN,
  );
  if (o.confidence != null && !Number.isFinite(confidence)) {
    errors.push('invalid confidence');
  }
  const files = Array.isArray(o.files)
    ? o.files
        .map((f) => (typeof f === 'string' ? f : (f && (f.path || f.name)) || ''))
        .map((s) => String(s || '').trim())
        .filter(Boolean)
    : [];
  return {
    ok: errors.length === 0,
    errors,
    task_type: taskType || null,
    deliverable_kind: kind || null,
    confidence: Number.isFinite(confidence) ? confidence : null,
    files,
    unknowns: asStringList(o.unknowns),
    assumptions: asStringList(o.assumptions),
    blocking_unknowns: asStringList(o.blocking_unknowns || o.blockingUnknowns),
  };
}

function isNonBlockingUnknown(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (NON_BLOCKING_UNKNOWN_RE.some((re) => re.test(t))) return true;
  // Prefer blocking patterns — if neither, treat style-like short fluff as non-blocking
  if (BLOCKING_UNKNOWN_RE.some((re) => re.test(t))) return false;
  if (/^(maybe|optional|nice\s*to\s*have)\b/i.test(t)) return true;
  return false;
}

function isBlockingUnknown(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (isNonBlockingUnknown(t)) return false;
  if (BLOCKING_UNKNOWN_RE.some((re) => re.test(t))) return true;
  // Default: keep as blocking only if it looks like a real gap question
  return /\b(which|what|where|should i|do you want|clarify)\b/i.test(t);
}

function filterBlockingUnknowns(unknowns, briefing, userMessage) {
  const signals = extractIntentSignals(userMessage);
  const b = briefing || {};
  const kind = String(b.deliverable_kind || '').toLowerCase();
  const list = asStringList(unknowns).filter((u) => isBlockingUnknown(u));

  // Clear deliver with path → no blocking path unknown
  const hasPath =
    (Array.isArray(b.files) && b.files.length > 0) ||
    signals.absoluteFiles.length > 0 ||
    signals.projectFiles.length > 0;
  const clearDeliver =
    kind === 'deliver' &&
    signals.deliverVerb &&
    (hasPath || signals.wantsArtifact || signals.minimalSingleFile);

  return list.filter((u) => {
    const low = String(u).toLowerCase();
    if (
      clearDeliver &&
      Array.isArray(b.files) &&
      b.files.length &&
      /path|where|live|slug/.test(low)
    ) {
      return false;
    }
    if (clearDeliver && /done|observable/.test(low)) return false;
    // Drop pure path unknowns for answer-only; keep answer-vs-deliver questions.
    if (
      kind === 'answer' &&
      /\b(path|slug)\b/.test(low) &&
      !/explain\s+only|create\s+files|answer\s+or\s+deliver|workspace/.test(low)
    ) {
      return false;
    }
    return true;
  });
}

function defaultConfidence(obj, unknowns) {
  const raw = clamp01(
    obj && (obj.confidence != null ? obj.confidence : obj.understanding_confidence),
    NaN,
  );
  if (Number.isFinite(raw)) return raw;
  if (unknowns && unknowns.length) return 0.55;
  return 0.82;
}

function buildClarificationQuestion(briefing, unknowns) {
  const existing = String(
    (briefing && (briefing.clarification_question || briefing.clarificationQuestion)) ||
      '',
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
 * Clarify only on blocking slots (kind, path/format, answer-vs-deliver).
 */
function applyUnderstandingGate(briefing, userMessage, opts) {
  const b = briefing && typeof briefing === 'object' ? briefing : {};
  const o = opts || {};
  const msg = String(userMessage || '').trim();
  const signals = extractIntentSignals(msg);
  let taskType = String(b.task_type || 'mixed').toLowerCase();

  if (o.skipGate || taskType === 'chat' || signals.greeting) {
    b.needs_clarification = false;
    return b;
  }

  if (signals.answerOnly) {
    b.deliverable_kind = 'answer';
    b.files = [];
    b.needs_clarification = false;
    b.clarification_question = '';
    b.blocking_unknowns = [];
    if (b.confidence == null) b.confidence = 0.88;
    return b;
  }

  if (
    isProceedDirective(msg) ||
    isWorkspaceDirective(msg) ||
    isRepoDirective(msg)
  ) {
    enrichFromSignals(b, msg);
    b.needs_clarification = false;
    b.clarification_question = '';
    b.blocking_unknowns = [];
    b.unknowns = asStringList(b.unknowns).filter((u) => !isBlockingUnknown(u));
    if (!b.task_type || b.task_type === 'mixed' || b.task_type === 'chat') {
      b.task_type = 'build';
    }
    if (!b.deliverable_kind || b.deliverable_kind === 'mixed') {
      b.deliverable_kind = 'deliver';
    }
    if (!Array.isArray(b.files) || !b.files.length) {
      b.files = inferDefaultFiles(msg, signals);
    }
    b.confidence = Math.max(clamp01(b.confidence, 0.7), 0.88);
    return b;
  }

  enrichFromSignals(b, msg);
  taskType = String(b.task_type || taskType).toLowerCase();

  const assumptions = asStringList(b.assumptions);
  let confidence = defaultConfidence(b, asStringList(b.unknowns));
  b.assumptions = assumptions;

  const kind = String(
    b.deliverable_kind || classifyDeliverableKind(msg, taskType),
  ).toLowerCase();
  b.deliverable_kind = kind;

  const hasFiles = Array.isArray(b.files) && b.files.length > 0;
  const concreteArtifact =
    signals.wantsArtifact ||
    signals.minimalSingleFile ||
    signals.wantsHtml ||
    signals.wantsPdf ||
    signals.wantsCsv ||
    signals.gitUrl ||
    hasFiles ||
    /\b(game|page|site|website|pdf|csv|repo|widget|calculator|todo|quiz|clock|dashboard|module|component|landing)\b/i.test(
      signals.lower,
    );
  // Bare "an app" / "something" without path is NOT clear enough to skip clarify.
  const vagueAppOnly =
    /\b(app|application|something(\s+cool)?)\b/i.test(signals.lower) &&
    !hasFiles &&
    !signals.projectSlug &&
    !signals.wantsHtml &&
    !signals.gitUrl &&
    !guessProjectSlug(signals.lower);
  const clearDeliver =
    (kind === 'deliver' ||
      taskType === 'build' ||
      taskType === 'document' ||
      taskType === 'debug' ||
      taskType === 'git') &&
    msg.length >= 8 &&
    concreteArtifact &&
    !vagueAppOnly &&
    (signals.deliverVerb ||
      signals.wantsArtifact ||
      hasFiles ||
      signals.gitUrl ||
      !!guessProjectSlug(signals.lower));

  // Soft unknowns from analyst → demote non-blocking
  let unknowns = filterBlockingUnknowns(asStringList(b.unknowns), b, msg);
  // Path already assumed — drop "where it should live" unknowns.
  if (hasFiles) {
    unknowns = unknowns.filter(
      (u) => !/where (it|they) should live|exact (path|location)|where should/i.test(String(u)),
    );
  }
  if (vagueAppOnly) {
    if (unknowns.indexOf('what exact deliverable and where it should live') < 0) {
      unknowns.push('what exact deliverable and where it should live');
    }
    confidence = Math.min(confidence, 0.5);
  }
  if (
    !concreteArtifact &&
    signals.deliverVerb &&
    (kind === 'deliver' || kind === 'mixed') &&
    !/\b(app|game|page|site|pdf|html|doc|file|repo|script)\b/i.test(signals.lower)
  ) {
    if (unknowns.indexOf('what exact deliverable and where it should live') < 0) {
      unknowns.push('what exact deliverable and where it should live');
    }
    confidence = Math.min(confidence, 0.5);
  }
  const explicitBlocking = asStringList(b.blocking_unknowns);
  explicitBlocking.forEach((u) => {
    if (unknowns.indexOf(u) < 0 && isBlockingUnknown(u)) unknowns.push(u);
  });

  if (kind === 'deliver' || taskType === 'build' || taskType === 'document') {
    const hasAcceptance =
      (Array.isArray(b.acceptance_tests) && b.acceptance_tests.length) ||
      (Array.isArray(b.success_criteria) && b.success_criteria.length);
    if (isSoftDoneWhen(b.done_when) && !hasAcceptance) {
      confidence = Math.min(confidence, clearDeliver ? 0.85 : 0.7);
    }
    if (
      !clearDeliver &&
      (!b.goal || String(b.goal).length < 8) &&
      !(Array.isArray(b.files) && b.files.length)
    ) {
      if (unknowns.indexOf('what exact deliverable and where it should live') < 0) {
        unknowns.push('what exact deliverable and where it should live');
      }
      confidence = Math.min(confidence, 0.55);
    }
  }

  if (kind === 'answer' && (taskType === 'build' || taskType === 'document')) {
    // Mismatch: analyst/task says build/document but kind is answer — always blocking.
    if (
      unknowns.indexOf(
        'should I explain only, or also create files in the workspace',
      ) < 0
    ) {
      unknowns.push('should I explain only, or also create files in the workspace');
    }
    confidence = Math.min(confidence, 0.55);
  }

  // Keep full unknowns for transparency but gate only on blocking
  b.unknowns = asStringList(b.unknowns).filter((u) => {
    const low = String(u || '').toLowerCase();
    return !/what\s*["']?done["']?\s*looks\s*like|observable check/i.test(low);
  });
  b.blocking_unknowns = unknowns;
  b.confidence = confidence;

  const confidenceExplicit =
    b._confidenceExplicit === true ||
    (opts && opts.confidenceExplicit === true);

  const mustClarify =
    (b.needs_clarification === true &&
      !(clearDeliver && unknowns.length === 0)) ||
    unknowns.length > 0 ||
    (confidenceExplicit &&
      confidence < CONFIDENCE_THRESHOLD &&
      !clearDeliver);

  // Prefer not to re-ask when path+verb already make the deliverable concrete.
  if (
    mustClarify &&
    clearDeliver &&
    hasFiles &&
    unknowns.length === 0 &&
    Number(confidence) >= 0.7
  ) {
    b.needs_clarification = false;
    b.clarification_question = '';
    return b;
  }

  // Concrete HTML/app ask with assumed path — never re-ask location.
  if (
    clearDeliver &&
    hasFiles &&
    unknowns.length === 0 &&
    (signals.wantsHtml || guessProjectSlug(signals.lower))
  ) {
    b.needs_clarification = false;
    b.clarification_question = '';
    b.blocking_unknowns = [];
    b.confidence = Math.max(confidence, 0.84);
    return b;
  }

  if (mustClarify) {
    b.needs_clarification = true;
    b.clarification_question = buildClarificationQuestion(b, unknowns);
  } else {
    b.needs_clarification = false;
    // Drop stale analyst location questions when we already assumed a path.
    if (
      hasFiles &&
      /where should|where (to|do i) save|exact deliverable and where/i.test(
        String(b.clarification_question || ''),
      )
    ) {
      b.clarification_question = '';
    }
    if (!String(b.clarification_question || '').trim()) {
      b.clarification_question = '';
    }
  }

  return b;
}

function resolveTaskType(analystType, userMessage, confidence) {
  let t = String(analystType || 'mixed').toLowerCase();
  if (VALID_TASK_TYPES.indexOf(t) < 0) t = 'mixed';
  const hint = softTaskTypeHint(userMessage);
  const conf = clamp01(confidence, 0.7);
  const route = preLlmRoute(userMessage);

  if (route.task_type && route.confidence >= 0.85) {
    return route.task_type;
  }

  if (!hint) return t;

  if (conf >= CONFIDENCE_THRESHOLD) {
    const deliveryHint =
      ['build', 'document', 'debug', 'git', 'run'].indexOf(hint) >= 0;
    const softUpgrade =
      ['browser', 'research', 'chat', 'question'].indexOf(hint) >= 0;
    const weakAnalyst = t === 'mixed' || t === 'chat' || t === 'question';
    const howTo = isHowToQuestion(userMessage);
    // Debug/build/document with clear delivery verbs beat how-to classification.
    if (deliveryHint && t === 'mixed') return hint;
    if (hint === 'debug' && (t === 'mixed' || t === 'question')) return hint;
    if (softUpgrade && t === 'mixed') return hint;
    if (
      deliveryHint &&
      weakAnalyst &&
      t !== 'question' &&
      t !== 'chat'
    ) {
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
 * Compile checkable done_when from files + task type (not soft prose).
 */
function compileDoneWhen(briefing, userMessage, taskType) {
  const b = briefing || {};
  const raw = b.done_when && String(b.done_when).trim();
  if (raw && !isSoftDoneWhen(raw)) return raw.slice(0, 400);

  const signals = extractIntentSignals(userMessage);
  const t = String(taskType || b.task_type || 'mixed').toLowerCase();
  const kind = String(b.deliverable_kind || '').toLowerCase();
  const files = Array.isArray(b.files)
    ? b.files.map(String).filter(Boolean)
    : signals.absoluteFiles.slice();
  const criteria = Array.isArray(b.success_criteria) ? b.success_criteria : [];
  if (criteria.length && !isSoftDoneWhen(criteria[0])) {
    return String(criteria[0]).slice(0, 400);
  }

  if (kind === 'answer' || t === 'chat') {
    return 'User received a clear direct answer to their question (no unnecessary workspace files)';
  }

  if (t === 'document') {
    if (files.length) {
      return (
        'File `' +
        files[0] +
        '` exists from a successful create_pdf/create_document/write_file tool result'
      );
    }
    if (signals.wantsPdf) {
      return 'A PDF file exists under /home/user/documents/ from a successful create_pdf tool result';
    }
    if (signals.wantsCsv) {
      return 'A CSV/spreadsheet exists under /home/user/documents/ from csv_write or write_file';
    }
    return 'A document file exists under /home/user/documents/ from create_document or write_file';
  }

  if (t === 'build' || t === 'debug') {
    if (files.length === 1 || b.minimal_single_file || signals.minimalSingleFile) {
      const path = files[0] || signals.absoluteFiles[0];
      if (path) {
        return (
          'File `' +
          path +
          '` exists from a successful write_file (only the requested file) and preview_project returns ok when applicable'
        );
      }
    }
    if (files.length) {
      return (
        'These files exist from successful write_file results: ' +
        files.slice(0, 4).join(', ') +
        '; preview_project returns ok'
      );
    }
    if (signals.wantsHtml || /\b(html|css|javascript|game|website)\b/i.test(signals.lower)) {
      const root = signals.projectSlug
        ? '/home/user/projects/' + signals.projectSlug + '/'
        : '/home/user/projects/';
      return (
        'Project files exist under `' +
        root +
        '` from successful write_file tool results and preview_project returns ok'
      );
    }
    return 'Required files exist in the workspace, preview_project returns ok (live localhost), and checks exit 0';
  }

  if (t === 'git') {
    return 'git_status is clean or a commit was created as requested';
  }
  if (t === 'research' || t === 'question') {
    return 'Answer cites real tool sources when tools were used, or answers directly if no tools needed';
  }
  if (t === 'browser') {
    return 'Requested browser actions completed with read_page/screenshot evidence';
  }
  if (t === 'run') {
    return 'Requested command finished; exit code and output reported';
  }
  return '';
}

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
  const unknowns = asStringList(b.blocking_unknowns || b.unknowns);
  if (unknowns.length) {
    lines.push('Still unclear: ' + unknowns.slice(0, 4).join('; '));
  }
  if (Array.isArray(b.files) && b.files.length) {
    lines.push('Files: ' + b.files.slice(0, 4).join(', '));
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

/**
 * Merge corrections, lift confidence, and clear clarify when the correction
 * resolves blocking slots (path/format/answer-vs-files).
 */
function applyCorrectionsWithRescore(briefing, corrections, userMessage) {
  let b = mergeCorrections(briefing, corrections);
  const merged = asStringList(b.user_corrections);
  if (!merged.length) return b;

  const blob = merged.join(' \n ').toLowerCase();
  const paths = extractPaths(merged.join('\n') + '\n' + String(userMessage || ''));
  const absoluteFiles = paths.filter((p) => /\.[A-Za-z0-9]{1,8}$/.test(p));
  if (absoluteFiles.length && (!Array.isArray(b.files) || !b.files.length)) {
    b.files = absoluteFiles.slice(0, 6);
  }

  if (/\b(pdf|document)\b/i.test(blob)) {
    b.task_type = 'document';
    b.deliverable_kind = 'deliver';
  } else if (/\b(html|website|app|page|index\.html)\b/i.test(blob)) {
    b.task_type = b.task_type === 'document' ? b.task_type : 'build';
    b.deliverable_kind = 'deliver';
  } else if (/\b(just\s+answer|explain\s+only|no\s+files|don't\s+create)\b/i.test(blob)) {
    b.deliverable_kind = 'answer';
    b.files = [];
    if (b.task_type === 'build' || b.task_type === 'document') b.task_type = 'question';
  }

  b.assumptions = asStringList(b.assumptions);
  merged.slice(0, 4).forEach((c) => {
    const line = 'Honoring correction: ' + String(c).slice(0, 120);
    if (b.assumptions.indexOf(line) < 0) b.assumptions.push(line);
  });

  const resolvesBlocking =
    absoluteFiles.length > 0 ||
    /\b(pdf|html|csv|xlsx|answer|explain|file|path|\/home\/user\/)\b/i.test(blob);
  if (resolvesBlocking) {
    b.blocking_unknowns = [];
    b.unknowns = asStringList(b.unknowns).filter((u) => !isBlockingUnknown(u));
    b.needs_clarification = false;
    b.clarification_question = '';
    b.confidence = Math.min(
      0.95,
      Math.max(clamp01(b.confidence, 0.7) + 0.12, 0.82),
    );
  } else {
    b.confidence = Math.min(0.95, clamp01(b.confidence, 0.7) + 0.06);
  }

  b = applyUnderstandingGate(b, userMessage || merged[0] || '', {
    skipGate: resolvesBlocking,
    confidenceExplicit: true,
  });
  if (resolvesBlocking) {
    b.needs_clarification = false;
    b.clarification_question = '';
  }
  return b;
}

/**
 * Tiny deterministic router scorer (feature weights — not an LLM).
 * Blends with the offline understanding classifier when available.
 */
function scoreRouter(userMessage) {
  const signals = extractIntentSignals(userMessage);
  const scores = {
    chat: 0,
    question: 0,
    research: 0,
    browser: 0,
    build: 0,
    debug: 0,
    document: 0,
    git: 0,
    run: 0,
    mixed: 0.05,
  };

  if (signals.greeting) scores.chat += 0.9;
  if (signals.howToLead && !signals.wantsArtifact) scores.question += 0.75;
  if (signals.answerOnly) scores.question += 0.55;
  if (signals.wantsResearch) scores.research += 0.7;
  if (signals.wantsBrowse) scores.browser += 0.8;
  if (signals.wantsDebug) scores.debug += 0.85;
  if (signals.wantsPdf || signals.wantsCsv) scores.document += 0.8;
  if (signals.wantsGit || signals.gitUrl) scores.git += 0.55;
  if (signals.gitUrl && /\b(fix|test|fail)\b/i.test(signals.lower)) scores.build += 0.7;
  if (signals.deliverVerb && signals.wantsArtifact) scores.build += 0.7;
  if (signals.absoluteFiles.length) scores.build += 0.55;
  if (signals.wantsHtml && signals.deliverVerb) scores.build += 0.45;
  if (signals.multiIntent) scores.build += 0.5;
  if (/\brun\s+(the\s+)?(tests?|script|command)\b/i.test(signals.lower)) {
    scores.run += 0.75;
  }
  if (signals.wantsGit && !signals.gitUrl && !/\bfix\b/i.test(signals.lower)) {
    scores.git += 0.35;
  }

  let top = 'mixed';
  let best = -1;
  Object.keys(scores).forEach((k) => {
    if (scores[k] > best) {
      best = scores[k];
      top = k;
    }
  });
  const confidence = Math.max(0.35, Math.min(0.95, best));
  const heuristic = {
    top,
    scores,
    confidence: Number(confidence.toFixed(3)),
    signals,
  };

  try {
    const Classifier = require('./understanding-classifier');
    const clf = Classifier.predict(userMessage, { signals });
    if (clf) return Classifier.blendRouter(heuristic, clf);
  } catch (e) {
    /* classifier optional */
  }
  return heuristic;
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

function detectClarifyFeedback(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (
    /\b(just (do|pick|decide|choose)|you (decide|pick|choose)|whatever|doesn't matter|dont care|don't care|surprise me)\b/i.test(
      t,
    )
  ) {
    return { kind: 'over_clarify', dismissed: true, text: t.slice(0, 200) };
  }
  if (
    /\b(you (should have|didn't) ask|why didn't you ask|missing (path|file|format)|unclear what you built)\b/i.test(
      t,
    )
  ) {
    return { kind: 'under_clarify', neededClarify: true, text: t.slice(0, 200) };
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
  VALID_TASK_TYPES,
  isSoftDoneWhen,
  isHowToQuestion,
  softTaskTypeHint,
  classifyDeliverableKind,
  extractPaths,
  extractIntentSignals,
  preLlmRoute,
  enrichFromSignals,
  validateBriefingSchema,
  filterBlockingUnknowns,
  isBlockingUnknown,
  isNonBlockingUnknown,
  applyUnderstandingGate,
  resolveTaskType,
  compileDoneWhen,
  suggestMode,
  formatIntentContract,
  mergeCorrections,
  applyCorrectionsWithRescore,
  scoreRouter,
  detectCorrectionMessage,
  detectClarifyFeedback,
  isProceedDirective,
  isWorkspaceDirective,
  isRepoDirective,
  expandFollowUpMessage,
  inferDefaultFiles,
  guessProjectSlug,
  answerFirstDoNot,
  asStringList,
  clamp01,
};
