'use strict';

/**
 * Agent autonomy policy — Ask / Assist / Autopilot.
 */

const LEVELS = ['ask', 'assist', 'autopilot'];

const ALWAYS_ASK_TOOLS = new Set([
  'desktop_exec',
  'desktop_pty',
  'git_push',
  'create_pull_request',
  'review_pull_request',
]);

const SESSION_ASK_TOOLS = new Set([
  'write_file',
  'append_file',
  'delete_file',
  'execute_command',
  'execute_code',
  'patch_file',
  'apply_patch',
  'process_manage',
  'image_generate',
  'text_to_speech',
  'delegate_task',
  'git_init',
  'git_add',
  'git_commit',
  'git_clone',
  'repo_open',
  'run_tests',
  'copy_file',
  'create_directory',
]);

const SAFE_AUTO_TOOLS = new Set([
  'create_pdf',
  'create_document',
  'export_document',
  'read_file',
  'list_directory',
  'find_files',
  'search_code',
  'git_status',
  'git_diff',
  'git_log',
  'repo_diagnostics',
  'view_tree',
  'search_web',
  'http_request',
  'fetch_url',
  'web_extract',
  'session_search',
  'skill_view',
  'skill_manage',
  'clarify',
  'get_page_text',
  'navigate',
  'tabs_create',
  'read_page',
  'find',
  'todo',
  'todo_write',
  'plan',
  'memory_get',
  'memory_set',
  'csv_read',
  'csv_query',
  'verify_project',
  'preview_project',
  'download_file',
  'upload_artifact',
  'vision_analyze',
  'video_analyze',
  'list_pull_requests',
  'get_pull_request',
  'get_ci_status',
]);

const PLAYBOOKS = {
  chat: 'Answer directly. Do not call tools unless the user clearly asks for action.',
  question:
    'Answer-first: explain clearly from knowledge. Use search_web/fetch_url only if facts may be stale. Do NOT create apps/PDFs/files unless the user asked for a deliverable. Cite sources briefly.',
  research:
    'search_web → fetch/read key pages → synthesize with [web:N] citations (grounded_citations). Optionally save /home/user/documents/research-notes.md.',
  browser:
    'tabs_create → navigate → read_page/find → act with refs. For dogfood QA also browser_console + evidence report. Re-read after navigation.',
  document:
    'Decide PDF vs markdown vs CSV/spreadsheet from the request. Research with search_web only if facts may be stale. Then create_pdf / create_document / csv_write into /home/user/documents (full polished content, hierarchy, scannable sections). Cite [web:N] when facts came from tools. Confirm path. No browse/code theatre.',
  build:
    'Reflect: confirm deliverable → write PLAN only if still missing → view_tree → write_file EACH file under /home/user/projects/<slug> (full content, real UX) → preview_project until ok → fix gaps → short answer with real paths. Never Python open()/zipfile or chat-only dumps. Apply design (+ web_designs if brand-matched).',
  debug:
    'Systematic debugging: tight red repro loop → root cause → one fix → re-run/preview. Stay in the project tree. Do not rewrite unrelated features.',
  git: 'git_status → stage → commit with a clear message. Push / create_pull_request only if asked; get_ci_status before claiming CI fixed.',
  run: 'execute_command / run_javascript / run_python for the requested command; report exit code and output.',
  mixed:
    'Inspect workspace (view_tree) first, then the highest-value delivery tool under /home/user/documents or /home/user/projects.',
};

const MAX_AUTO_RESUMES = 2;
const AUTO_RESUME_EXTRA_MS = 35000;
const AUTO_RESUME_EXTRA_STEPS = 4;

function normalizeAutonomy(level) {
  const v = String(level || 'assist').toLowerCase().trim();
  if (LEVELS.indexOf(v) >= 0) return v;
  return 'assist';
}

function toolRisk(tool) {
  const name = String(tool || '');
  if (ALWAYS_ASK_TOOLS.has(name)) return 'always';
  if (SESSION_ASK_TOOLS.has(name)) return 'session';
  if (SAFE_AUTO_TOOLS.has(name)) return 'safe';
  // Unknown mutating-ish tools → session
  if (/^(write|delete|exec|run_|desktop_|git_|shell_)/.test(name)) return 'session';
  return 'safe';
}

/**
 * Whether to pause for plan approval before executing.
 */
function shouldAwaitPlan(autonomy, taskType, isLight) {
  if (isLight) return false;
  const level = normalizeAutonomy(autonomy);
  const t = String(taskType || 'mixed').toLowerCase();
  if (t === 'chat') return false;
  if (level === 'autopilot') return false;
  if (level === 'assist') {
    return ['build', 'debug', 'git', 'run', 'mixed', 'document', 'research'].indexOf(t) >= 0;
  }
  // ask
  return t !== 'question';
}

/**
 * Whether a tool needs an explicit user approval pause.
 */
function toolNeedsApproval(autonomy, tool, approvedSet) {
  const level = normalizeAutonomy(autonomy);
  const risk = toolRisk(tool);
  const approved =
    approvedSet instanceof Set
      ? approvedSet
      : new Set(Array.isArray(approvedSet) ? approvedSet : []);

  if (risk === 'safe') return false;
  if (approved.has(tool) || approved.has('*') || approved.has(risk)) return false;

  if (risk === 'always') return true;
  if (level === 'ask' && risk === 'session') return true;
  if (level === 'assist' && risk === 'session') {
    // Assist: allow session tools after first batch approval of "session"
    return !approved.has('session');
  }
  // autopilot: session tools free; always still asks
  return false;
}

function shouldAutoResume(autonomy, reason, resumeCount) {
  const level = normalizeAutonomy(autonomy);
  if (level === 'ask') return false;
  const n = Number(resumeCount) || 0;
  if (n >= MAX_AUTO_RESUMES) return false;
  const r = String(reason || '');
  return r === 'time_budget' || r === 'step_budget' || r === 'max_steps';
}

function playbookForTaskType(taskType) {
  const t = String(taskType || 'mixed').toLowerCase();
  return PLAYBOOKS[t] || PLAYBOOKS.mixed;
}

function buildRunMemoryPack({
  goal,
  taskType,
  todos,
  workflow,
  filesTouched,
  lastFailures,
  autonomy,
  prefs,
}) {
  const open = (todos || []).filter((t) => t && t.status !== 'done');
  const done = (todos || []).filter((t) => t && t.status === 'done');
  const wf = workflow || {};
  const lines = [
    '# Run memory (durable for this agent run — follow this)',
    'Autonomy: ' + normalizeAutonomy(autonomy),
    'Task type: ' + String(taskType || 'mixed'),
    'Goal: ' + String(goal || '').slice(0, 400),
    'Phase: explored=' +
      !!wf.explored +
      ' planned=' +
      !!wf.planned +
      ' implemented=' +
      !!wf.implemented +
      ' verified=' +
      !!wf.verified,
    'Todos done: ' + done.length + ' · open: ' + open.length,
  ];
  if (open.length) {
    lines.push(
      'Open todos:\n' +
        open
          .slice(0, 12)
          .map((t) => '- [' + t.id + '] ' + t.content)
          .join('\n'),
    );
  }
  if (filesTouched && filesTouched.length) {
    lines.push(
      'Files touched:\n' +
        filesTouched
          .slice(-20)
          .map((f) => '- ' + f)
          .join('\n'),
    );
  }
  if (lastFailures && lastFailures.length) {
    lines.push(
      'Recent failures:\n' +
        lastFailures
          .slice(-5)
          .map((f) => '- ' + f)
          .join('\n'),
    );
  }
  if (prefs && typeof prefs === 'object') {
    const bits = Object.keys(prefs)
      .slice(0, 8)
      .map((k) => k + '=' + String(prefs[k]).slice(0, 80));
    if (bits.length) lines.push('User prefs: ' + bits.join('; '));
  }
  lines.push('Playbook: ' + playbookForTaskType(taskType));
  return lines.join('\n');
}

/**
 * Prefer a BYOK model when Workers AI would be used and a key exists.
 */
function preferByokModel(model, byokFlags, defaults) {
  const raw = String(model || '').trim();
  const flags = byokFlags || {};
  const def = defaults || {};
  const isChatre =
    !raw ||
    raw.indexOf(':') < 0 ||
    /^chatre:/i.test(raw) ||
    raw.indexOf('@cf/') === 0;

  if (!isChatre) return raw;

  if (def.model && /^(openrouter|aihubmix|zai|groq|deepseek|mistral|xai|anthropic|openai|google):/i.test(String(def.model))) {
    return String(def.model);
  }
  if (def.preferByok === false) return raw || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

  if (flags.openrouter) return 'openrouter:openrouter/free';
  if (flags.aihubmix) return 'aihubmix:gpt-4o-mini';
  if (flags.zai) return 'zai:glm-5.3-flash';
  if (flags.groq) return 'groq:openai/gpt-oss-20b';
  if (flags.deepseek) return 'deepseek:deepseek-chat';
  if (flags.mistral) return 'mistral:mistral-small-latest';
  if (flags.xai) return 'xai:grok-3-mini';
  if (flags.openai) return 'openai:gpt-4o-mini';
  if (flags.anthropic) return 'anthropic:claude-3-5-haiku-latest';
  if (flags.google) return 'google:gemini-2.5-flash';
  return raw || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
}

function companionInstallForOs(os) {
  const api =
    'CHATRE_API_BASE=https://chatre-api.vercel.app CHATRE_API_TOKEN=YOUR_TOKEN';
  const o = String(os || '').toLowerCase();
  if (o === 'windows') {
    return {
      title: 'Desktop companion on Windows',
      steps: [
        'Install Node.js 20+ from nodejs.org',
        'In PowerShell: git clone your chatre-api repo (or download release)',
        'cd chatre-api; npm install',
        api + ' npm run companion:start',
      ],
      command: api + ' npm run companion:start',
    };
  }
  if (o === 'macos') {
    return {
      title: 'Desktop companion on macOS',
      steps: [
        'Install Node via Homebrew: brew install node',
        'Clone/open the chatre-api project',
        'npm install',
        api + ' npm run companion:start',
      ],
      command: api + ' npm run companion:start',
    };
  }
  if (o === 'linux' || o === 'chromeos') {
    return {
      title: 'Desktop companion on Linux',
      steps: [
        'Install Node.js 20+',
        'cd chatre-api && npm install',
        api + ' npm run companion:start',
      ],
      command: api + ' npm run companion:start',
    };
  }
  return {
    title: 'Desktop companion',
    steps: [
      'Requires Node.js on the machine you want to control',
      api + ' npm run companion:start',
    ],
    command: api + ' npm run companion:start',
  };
}

module.exports = {
  LEVELS,
  ALWAYS_ASK_TOOLS,
  SESSION_ASK_TOOLS,
  SAFE_AUTO_TOOLS,
  PLAYBOOKS,
  MAX_AUTO_RESUMES,
  AUTO_RESUME_EXTRA_MS,
  AUTO_RESUME_EXTRA_STEPS,
  normalizeAutonomy,
  toolRisk,
  shouldAwaitPlan,
  toolNeedsApproval,
  shouldAutoResume,
  playbookForTaskType,
  buildRunMemoryPack,
  preferByokModel,
  companionInstallForOs,
};
