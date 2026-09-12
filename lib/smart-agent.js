'use strict';

/**
 * Smarter agent policies — early stop, done_when, budgets, workspace inventory.
 */

const TOKEN_BUDGETS = {
  analyst: 700,
  executor: 900,
  critic: 480,
  final: 700,
  document_body: 1800,
};

const EARLY_STOP = {
  maxConsecutiveFails: 2,
  maxStepsWithoutSuccess: 4,
};

const STEP_CAPS_SMART = {
  chat: 1,
  question: 4,
  research: 8,
  browser: 10,
  build: 10,
  debug: 10,
  document: 6,
  git: 6,
  run: 6,
  mixed: 8,
};

const SKILL_BY_TASK = {
  chat: null,
  question: null,
  document: 'documents',
  build: 'coding',
  debug: 'debugging',
  git: 'git',
  research: 'web_research',
  browser: 'browser',
  run: 'shell_debug',
  // mixed: do not force "computer" — that caused HTML/game builds to skip write_file
  mixed: null,
};

function deriveDoneWhen(briefing, userMessage, taskType) {
  const b = briefing || {};
  if (b.done_when && String(b.done_when).trim()) {
    return String(b.done_when).trim().slice(0, 400);
  }
  const t = String(taskType || b.task_type || 'mixed').toLowerCase();
  const msg = String(userMessage || '').toLowerCase();
  const criteria = Array.isArray(b.success_criteria) ? b.success_criteria : [];
  if (criteria.length) return String(criteria[0]).slice(0, 400);

  if (t === 'document') {
    if (/\bpdf\b/.test(msg)) {
      return 'A PDF file exists under /home/user/documents/ from a successful create_pdf tool result';
    }
    return 'A document file exists under /home/user/documents/ from create_document or write_file';
  }
  if (t === 'build' || t === 'debug') {
    if (/\b(html|css|javascript|\.js\b|game|website|webpage)\b/.test(msg)) {
      return 'Project files (e.g. index.html and related assets) exist under /home/user/projects/ from successful write_file tool results';
    }
    return 'Required files exist in the workspace and verify_project or a command exited 0';
  }
  if (t === 'git') {
    return 'git_status is clean or a commit was created as requested';
  }
  if (t === 'research' || t === 'question') {
    return 'Answer cites real tool sources when tools were used, or answers directly if no tools needed';
  }
  if (t === 'chat') return 'User received a direct conversational reply (no tools)';
  return 'User-visible goal completed with evidence in workspace or tool results';
}

function pickPrimarySkill(skills, taskType) {
  const t = String(taskType || 'mixed').toLowerCase();
  const preferred = SKILL_BY_TASK[t];
  const list = Array.isArray(skills) ? skills.map(String) : [];
  if (preferred && list.indexOf(preferred) >= 0) return [preferred];
  // Prefer delivery skills present in the detection list over inventing a task default.
  if (preferred && list.length === 0) return [preferred];
  if (list.indexOf('coding') >= 0) return ['coding'];
  if (list.indexOf('documents') >= 0) return ['documents'];
  if (list.indexOf('debugging') >= 0) return ['debugging'];
  if (list.length) return [list[0]];
  if (preferred) return [preferred];
  return [];
}

function workspaceInventory(files, opts) {
  const o = opts || {};
  const limit = o.limit || 48;
  const map = files || {};
  const paths = Object.keys(map)
    .filter((p) => map[p] && map[p].type === 'file')
    .sort();
  const dirs = Object.keys(map)
    .filter((p) => map[p] && map[p].type === 'dir')
    .sort();
  const shown = paths.slice(0, limit);
  const projectDirs = dirs
    .filter((p) => /^\/home\/user\/projects\/[^/]+$/.test(p))
    .map((p) => p.split('/').pop());
  const lines = [
    '# Workspace inventory (authoritative — use these paths)',
    'Root layout: /home/user/documents (docs/PDFs), /home/user/projects (code), /tmp (scratch)',
    'File count: ' + paths.length + ' · dirs: ' + dirs.length,
  ];
  if (projectDirs.length) {
    lines.push(
      'Projects: ' +
        projectDirs
          .map((s) => {
            const agents = map['/home/user/projects/' + s + '/AGENTS.md'];
            return s + (agents && agents.type === 'file' ? ' ✓AGENTS.md' : '');
          })
          .join(', '),
    );
  }
  if (o.activeProject) {
    lines.push('Active project: /home/user/projects/' + o.activeProject);
  }
  if (shown.length) {
    lines.push(
      'Files:\n' +
        shown
          .map((p) => {
            const f = map[p];
            const enc = f.encoding === 'base64' ? ' binary' : '';
            const n =
              f.content != null ? String(f.content).length : 0;
            return '- ' + p + enc + (n ? ' (~' + n + ' chars)' : '');
          })
          .join('\n'),
    );
  } else {
    lines.push('Files: (empty — create under /home/user/documents or /home/user/projects)');
  }
  if (paths.length > limit) {
    lines.push('…+' + (paths.length - limit) + ' more files');
  }
  lines.push(
    'Rules: keep one active project; read AGENTS.md before edits; view_tree before first write; never invent paths.',
  );
  return {
    text: lines.join('\n'),
    fileCount: paths.length,
    paths: shown,
    allPaths: paths,
    projects: projectDirs,
    activeProject: o.activeProject || null,
  };
}

function isSuccessfulTool(tool, result) {
  if (!result || result.ok === false) return false;
  if (result.needs_approval) return false;
  const t = String(tool || '');
  if (
    /^(create_pdf|create_document|write_file|append_file|patch_file|upload_artifact)$/.test(
      t,
    )
  ) {
    return !!(result.path || result.ok);
  }
  if (t === 'execute_command' || t === 'verify_project' || t === 'run_javascript' || t === 'run_python') {
    return result.ok !== false && (result.code == null || result.code === 0);
  }
  if (/^(git_commit|git_add|git_init)$/.test(t)) return true;
  if (/^(search_web|fetch_url|read_file|view_tree|list_directory)$/.test(t)) {
    return true; // progress, but not "delivery" success
  }
  return result.ok !== false;
}

/**
 * Real workspace delivery — file artifacts only.
 * Shell / python / verify are progress, not delivery (they used to let the
 * model "finish" after narrating writes or running `ls`).
 */
function isDeliverySuccess(tool, result) {
  if (!isSuccessfulTool(tool, result)) return false;
  const t = String(tool || '');
  return /^(create_pdf|create_document|write_file|append_file|patch_file|apply_patch|upload_artifact|image_generate|text_to_speech|git_commit)$/.test(
    t,
  );
}

/** Progress tools (shell/js/python/verify) — useful, but not "delivered". */
function isProgressSuccess(tool, result) {
  if (!isSuccessfulTool(tool, result)) return false;
  const t = String(tool || '');
  return /^(execute_command|execute_code|run_javascript|run_python|verify_project|process_manage)$/.test(
    t,
  );
}

function artifactLooksDone(doneWhen, ctx) {
  const want = String(doneWhen || '').toLowerCase();
  const files = (ctx && ctx.files) || {};
  const touched = (ctx && ctx.filesTouched) || [];
  const paths = Object.keys(files).filter(
    (p) => files[p] && files[p].type === 'file',
  );

  if (/pdf/.test(want)) {
    const pdf = paths.some((p) => /\.pdf$/i.test(p)) || touched.some((p) => /\.pdf$/i.test(p));
    return pdf;
  }
  if (/document|markdown|\/home\/user\/documents/.test(want)) {
    return (
      touched.some((p) => /\/home\/user\/documents\//.test(p)) ||
      paths.some((p) => /\/home\/user\/documents\//.test(p) && p !== '/home/user/readme.txt')
    );
  }
  if (/\/home\/user\/projects|index\.html|\.html|write_file|project files/.test(want)) {
    return (
      touched.some((p) => /\/home\/user\/projects\//.test(p)) ||
      paths.some((p) => /\/home\/user\/projects\//.test(p))
    );
  }
  if (/verify|exit 0|command/.test(want)) {
    return !!(ctx && ctx.verifiedAny);
  }
  if (/commit/.test(want)) {
    return !!(ctx && ctx.gitCommitted);
  }
  // Generic: any delivery touch
  return touched.length > 0;
}

function checkEarlyStop({
  consecutiveFails,
  stepsWithoutSuccess,
  taskType,
}) {
  const t = String(taskType || 'mixed').toLowerCase();
  if (t === 'chat') return null;
  if (consecutiveFails >= EARLY_STOP.maxConsecutiveFails) {
    return {
      reason: 'consecutive_tool_failures',
      message:
        'Stopped early: ' +
        consecutiveFails +
        ' consecutive tool failures without progress. Fix the blocker or narrow the request.',
    };
  }
  if (stepsWithoutSuccess >= EARLY_STOP.maxStepsWithoutSuccess) {
    return {
      reason: 'no_delivery_progress',
      message:
        'Stopped early: ' +
        stepsWithoutSuccess +
        ' steps with no workspace delivery (file write / verify / commit). Avoid explore-only loops.',
    };
  }
  return null;
}

function shrinkToolResult(result, budget) {
  const limit = budget || 900;
  if (!result || typeof result !== 'object') return result;
  const clone = Object.assign({}, result);
  ['output', 'content', 'text', 'guide', 'stdout', 'stderr'].forEach((k) => {
    if (typeof clone[k] === 'string' && clone[k].length > limit) {
      clone[k] =
        clone[k].slice(0, limit) +
        '\n…[truncated ' +
        clone[k].length +
        ' chars]';
    }
  });
  if (clone.screenshot_base64) {
    clone.hasScreenshot = true;
    delete clone.screenshot_base64;
  }
  return clone;
}

function buildRunDiagnostics(state) {
  const s = state || {};
  return {
    task_type: s.taskType || null,
    done_when: s.doneWhen || null,
    steps: s.steps || 0,
    toolsUsed: s.toolsUsed || 0,
    deliverySuccess: !!s.deliverySuccess,
    consecutiveFails: s.consecutiveFails || 0,
    stepsWithoutSuccess: s.stepsWithoutSuccess || 0,
    filesTouched: (s.filesTouched || []).slice(-20),
    stopReason: s.stopReason || 'done',
    primarySkill: s.primarySkill || null,
    model: s.model || null,
    workspaceFiles: s.workspaceFileCount || 0,
  };
}

function smartMaxSteps(taskType, briefingMax) {
  const t = String(taskType || 'mixed').toLowerCase();
  const cap = STEP_CAPS_SMART[t] != null ? STEP_CAPS_SMART[t] : STEP_CAPS_SMART.mixed;
  if (briefingMax) return Math.min(cap, Number(briefingMax) || cap);
  return cap;
}

function workspacePlaybookExtra(taskType) {
  const t = String(taskType || 'mixed').toLowerCase();
  const common =
    'Use the live workspace: view_tree("/home/user") or list_directory before writing; put docs in /home/user/documents and code in /home/user/projects/<name>; confirm with read_file or list_directory after writes.';
  if (t === 'document') {
    return (
      common +
      ' Prefer create_pdf/create_document over write_file for user-facing docs. Apply Design skill: hierarchy, scannable sections, no wall-of-text. One successful tool = done.'
    );
  }
  if (t === 'build' || t === 'debug') {
    return (
      common +
      ' Scaffold under /home/user/projects/<slug>. For EVERY source file call write_file with FULL content — never Python open()/zipfile theatre or chat-only code dumps. For UI/HTML/CSS/apps apply Design skill. After writes list_directory to confirm. Then verify_project or execute_command if useful. Do not browse unless required.'
    );
  }
  if (t === 'research') {
    return (
      common +
      ' Optionally save notes to /home/user/documents/research-notes.md after gathering sources.'
    );
  }
  return common;
}

function shouldDocumentFastPath(briefing, userMessage) {
  const t = String((briefing && briefing.task_type) || '').toLowerCase();
  if (t !== 'document') return false;
  const msg = String(userMessage || '').toLowerCase();
  // Fast path for clear create/write doc requests
  return /\b(pdf|document|report|guide|manual|essay|book|readme|write.?up)\b/.test(
    msg,
  );
}

module.exports = {
  TOKEN_BUDGETS,
  EARLY_STOP,
  STEP_CAPS_SMART,
  deriveDoneWhen,
  pickPrimarySkill,
  workspaceInventory,
  isSuccessfulTool,
  isDeliverySuccess,
  isProgressSuccess,
  artifactLooksDone,
  checkEarlyStop,
  shrinkToolResult,
  buildRunDiagnostics,
  smartMaxSteps,
  workspacePlaybookExtra,
  shouldDocumentFastPath,
};
