'use strict';

/**
 * Feature extraction for the understanding classifier.
 * Pure functions — shared by trainer + runtime.
 */

const FEATURE_NAMES = [
  'bias',
  'len_norm',
  'greeting',
  'howToLead',
  'answerOnly',
  'deliverVerb',
  'wantsArtifact',
  'wantsHtml',
  'wantsPdf',
  'wantsCsv',
  'wantsDebug',
  'wantsBrowse',
  'wantsResearch',
  'wantsGit',
  'gitUrl',
  'multiIntent',
  'hasAbsoluteFiles',
  'hasProjectSlug',
  'minimalSingleFile',
  'vagueApp',
  'proceedDirective',
  'workspaceDirective',
  'repoDirective',
  'typoBuild',
  'word_build',
  'word_fix',
  'word_explain',
  'word_pdf',
  'word_html',
  'word_repo',
  'word_test',
  'word_clone',
  'qmark',
  'word_document',
  'word_guide',
];

const TASK_TYPES = [
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

const KIND_TYPES = ['answer', 'deliver', 'mixed'];

function bool01(v) {
  return v ? 1 : 0;
}

function extractFeatureVector(userMessage, signals, helpers) {
  const msg = String(userMessage || '');
  const lower = msg.toLowerCase();
  const sig = signals || {};
  const h = helpers || {};
  const lenNorm = Math.min(1, msg.length / 240);
  const vagueApp =
    /\b(app|application|something(\s+cool)?)\b/i.test(lower) &&
    !sig.wantsHtml &&
    !(sig.absoluteFiles && sig.absoluteFiles.length) &&
    !sig.projectSlug;

  const feats = {
    bias: 1,
    len_norm: lenNorm,
    greeting: bool01(sig.greeting),
    howToLead: bool01(sig.howToLead),
    answerOnly: bool01(sig.answerOnly),
    deliverVerb: bool01(sig.deliverVerb),
    wantsArtifact: bool01(sig.wantsArtifact),
    wantsHtml: bool01(sig.wantsHtml),
    wantsPdf: bool01(sig.wantsPdf),
    wantsCsv: bool01(sig.wantsCsv),
    wantsDebug: bool01(sig.wantsDebug),
    wantsBrowse: bool01(sig.wantsBrowse),
    wantsResearch: bool01(sig.wantsResearch),
    wantsGit: bool01(sig.wantsGit),
    gitUrl: bool01(sig.gitUrl),
    multiIntent: bool01(sig.multiIntent),
    hasAbsoluteFiles: bool01(sig.absoluteFiles && sig.absoluteFiles.length),
    hasProjectSlug: bool01(sig.projectSlug),
    minimalSingleFile: bool01(sig.minimalSingleFile),
    vagueApp: bool01(vagueApp),
    proceedDirective: bool01(h.isProceedDirective && h.isProceedDirective(msg)),
    workspaceDirective: bool01(
      h.isWorkspaceDirective && h.isWorkspaceDirective(msg),
    ),
    repoDirective: bool01(h.isRepoDirective && h.isRepoDirective(msg)),
    typoBuild: bool01(/\b(buld|bulid|creat)\b/i.test(lower)),
    word_build: bool01(/\b(build|make|create|scaffold|implement)\b/i.test(lower)),
    word_fix: bool01(/\b(fix|debug|failing|error|crash)\b/i.test(lower)),
    word_explain: bool01(/\b(explain|how|what|why|describe)\b/i.test(lower)),
    word_pdf: bool01(/\bpdf\b/i.test(lower)),
    word_html: bool01(/\bhtml\b/i.test(lower)),
    word_repo: bool01(/\brepo|github\.com|git clone\b/i.test(lower)),
    word_test: bool01(/\btests?\b/i.test(lower)),
    word_clone: bool01(/\bclone\b/i.test(lower)),
    qmark: bool01(/\?/.test(msg)),
    word_document: bool01(/\b(document|docs?|report|memo|manual|essay)\b/i.test(lower)),
    word_guide: bool01(/\b(guide|handbook|book)\b/i.test(lower)),
  };

  return FEATURE_NAMES.map((name) => Number(feats[name] || 0));
}

function featuresToObject(vec) {
  const out = {};
  FEATURE_NAMES.forEach((n, i) => {
    out[n] = vec[i];
  });
  return out;
}

module.exports = {
  FEATURE_NAMES,
  TASK_TYPES,
  KIND_TYPES,
  extractFeatureVector,
  featuresToObject,
};
