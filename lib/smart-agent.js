'use strict';

/**
 * Smarter agent policies — early stop, done_when, budgets, workspace inventory.
 */

const TOKEN_BUDGETS = {
  analyst: 1100,
  executor: 1400,
  critic: 700,
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
  const Understanding = require('./understanding');
  return Understanding.compileDoneWhen(briefing, userMessage, taskType);
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
  if (t === 'execute_command' || t === 'verify_project' || t === 'preview_project' || t === 'run_javascript' || t === 'run_python') {
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
  return /^(execute_command|execute_code|run_javascript|run_python|verify_project|preview_project|process_manage)$/.test(
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
  // Generic: require an actual delivery success, not a mere touch.
  return !!(ctx && ctx.deliverySuccess) && touched.length > 0;
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
    if (typeof clone[k] !== 'string' || clone[k].length <= limit) return;
    if (clone.spill_path) {
      clone[k] =
        clone[k].slice(0, Math.min(limit, 600)) +
        '\n…[see spill_path ' +
        clone.spill_path +
        ']';
      return;
    }
    clone[k] =
      clone[k].slice(0, limit) +
      '\n…[truncated ' +
      clone[k].length +
      ' chars]';
  });
  if (clone.screenshot_base64) {
    clone.hasScreenshot = true;
    delete clone.screenshot_base64;
  }
  if (clone.preview && clone.preview.files) {
    clone.preview = Object.assign({}, clone.preview, {
      files: undefined,
      fileKeys: Object.keys(clone.preview.files || {}).slice(0, 40),
      filesOmitted: true,
    });
    delete clone.preview.files;
  }
  if (clone.errors && Array.isArray(clone.errors) && clone.errors.length > 20) {
    clone.errors = clone.errors.slice(0, 20);
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
      ' Scaffold under /home/user/projects/<slug>. For EVERY source file call write_file with FULL content — never Python open()/zipfile theatre or chat-only code dumps. For UI/HTML/CSS/apps apply Design skill. After writes list_directory to confirm. Then MUST call preview_project (live localhost preview + debug). Fix any errors and re-preview. Do not claim done until preview_project ok. Do not browse unless required.'
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
