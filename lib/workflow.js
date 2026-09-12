'use strict';

/**
 * Chatre agent loop helpers — todos, phase tracking, finish gates.
 */

const { CHATRE_AGENT_PROMPT } = require('./agent-prompt');

const PHASES = ['explore', 'plan', 'implement', 'verify', 'done'];

function emptyTodos() {
  return [];
}

function normalizeTodos(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, i) => {
      if (typeof item === 'string') {
        return {
          id: 't' + (i + 1),
          content: item,
          status: 'pending',
          owner: 'build',
          phase: 'implement',
        };
      }
      if (!item || typeof item !== 'object') return null;
      const owner = String(item.owner || item.agent || 'build').toLowerCase();
      return {
        id: String(item.id || 't' + (i + 1)),
        content: String(item.content || item.text || item.title || ''),
        status:
          item.status === 'done' || item.status === 'completed'
            ? 'done'
            : item.status === 'in_progress'
              ? 'in_progress'
              : 'pending',
        owner,
        phase: String(
          item.phase ||
            (owner === 'explore'
              ? 'explore'
              : owner === 'verify'
                ? 'verify'
                : owner === 'plan'
                  ? 'plan'
                  : 'implement'),
        ),
        active_form: item.active_form,
      };
    })
    .filter((t) => t && t.content);
}

function applyTodoAction(todos, params) {
  const action = String((params && params.action) || 'list').toLowerCase();
  let next = Array.isArray(todos) ? todos.map((t) => ({ ...t })) : [];
  let text = '';

  if (action === 'set' || action === 'replace') {
    next = normalizeTodos(params.items || params.todos || []);
    text = 'Todos set (' + next.length + '):\n' + formatTodos(next);
  } else if (action === 'add') {
    const item = normalizeTodos([
      {
        id: params.id,
        content: params.content || params.text || params.title,
      },
    ])[0];
    if (!item) return { ok: false, error: 'content required', todos: next };
    if (next.some((t) => t.id === item.id)) {
      item.id = item.id + '_' + Math.random().toString(36).slice(2, 5);
    }
    next.push(item);
    text = 'Added todo ' + item.id + '\n' + formatTodos(next);
  } else if (action === 'done' || action === 'complete' || action === 'check') {
    const id = String(params.id || '');
    const hit = next.find((t) => t.id === id);
    if (!hit) return { ok: false, error: 'Unknown todo id: ' + id, todos: next };
    hit.status = 'done';
    text = 'Checked off ' + id + '\n' + formatTodos(next);
  } else if (action === 'list' || action === 'show') {
    text = formatTodos(next) || '(no todos)';
  } else {
    return { ok: false, error: 'Unknown todo action: ' + action, todos: next };
  }

  return {
    ok: true,
    tool: 'todo',
    action,
    todos: next,
    open: next.filter((t) => t.status !== 'done').length,
    done: next.filter((t) => t.status === 'done').length,
    text,
    guide: text,
  };
}

function formatTodos(todos) {
  if (!todos || !todos.length) return '(no todos)';
  return todos
    .map((t) => {
      const mark = t.status === 'done' ? '- [x] ' : t.status === 'in_progress' ? '- [~] ' : '- [ ] ';
      const own = t.owner ? '[' + t.owner + '] ' : '';
      return mark + own + t.id + ': ' + t.content;
    })
    .join('\n');
}

function recordToolPhase(state, tool) {
  const s = state || {
    explored: false,
    planned: false,
    implemented: false,
    fileDelivered: false,
    ranAction: false,
    verified: false,
    previewFailed: false,
    todos: [],
  };
  if (
    tool === 'view_tree' ||
    tool === 'list_directory' ||
    tool === 'read_file' ||
    tool === 'find_files' ||
    tool === 'search_code' ||
    tool === 'navigate' ||
    tool === 'read_page' ||
    tool === 'find' ||
    tool === 'get_page_text' ||
    tool === 'search_web' ||
    tool === 'tabs_create' ||
    tool === 'browser_navigate' ||
    tool === 'browser_read' ||
    tool === 'browser_content' ||
    tool === 'browser_screenshot' ||
    tool === 'http_request'
  ) {
    s.explored = true;
  }
  if (tool === 'plan' || tool === 'todo' || tool === 'todo_write') {
    s.planned = true;
  }
  if (tool === 'delegate_task') {
    s.explored = true;
  }
  if (
    tool === 'write_file' ||
    tool === 'append_file' ||
    tool === 'patch_file' ||
    tool === 'apply_patch' ||
    tool === 'create_document' ||
    tool === 'create_pdf' ||
    tool === 'upload_artifact' ||
    tool === 'image_generate' ||
    tool === 'text_to_speech' ||
    tool === 'git_commit'
  ) {
    s.fileDelivered = true;
    s.implemented = true;
  }
  if (
    tool === 'execute_command' ||
    tool === 'execute_code' ||
    tool === 'run_javascript' ||
    tool === 'run_python' ||
    tool === 'process_manage' ||
    tool === 'computer' ||
    tool === 'form_input' ||
    tool === 'navigate' ||
    tool === 'browser_click' ||
    tool === 'browser_type' ||
    tool === 'browser_press' ||
    tool === 'browser_evaluate' ||
    tool === 'browser_scroll' ||
    tool === 'http_request'
  ) {
    // Shell/browser actions are progress — not file delivery for builds.
    s.ranAction = true;
    if (tool !== 'execute_command' && tool !== 'execute_code' &&
        tool !== 'run_javascript' && tool !== 'run_python' &&
        tool !== 'process_manage') {
      s.implemented = true;
    }
  }
  if (
    tool === 'verify_project' ||
    tool === 'preview_project' ||
    tool === 'execute_command' ||
    tool === 'run_javascript' ||
    tool === 'run_python' ||
    tool === 'list_directory' ||
    tool === 'view_tree' ||
    tool === 'computer' ||
    tool === 'get_page_text' ||
    tool === 'read_page' ||
    tool === 'browser_screenshot' ||
    tool === 'browser_read'
  ) {
    if (tool === 'preview_project') {
      // Mark verified only when the caller also clears previewFailed on ok results.
      s.ranAction = true;
    } else if (tool === 'verify_project' || tool === 'list_directory' || tool === 'view_tree') {
      s.verified = true;
    } else if (s.fileDelivered || s.implemented) s.verified = true;
  }
  return s;
}

/**
 * Internal model nudge — never show as product/chat copy.
 * Returns null if OK to finish, or a short continue hint for the model only.
 */
function finishGate({
  state,
  todos,
  step,
  forcePlan,
  taskType,
  deliverySuccess,
  requirePlan,
  planPath,
  previewOk,
  previewFailed,
}) {
  if (!forcePlan) return null;
  const open = (todos || []).filter((t) => t.status !== 'done');
  if (open.length) {
    return (
      '[internal] ' +
      open.length +
      ' open todo(s) remain. Call todo({action:"done", id}) for finished items, then continue with tools. Do not narrate this message to the user.\n' +
      formatTodos(open)
    );
  }

  if (requirePlan && !planPath && step < 10) {
    return (
      '[internal] Approved-plan builds need a plan artifact (PLAN.md or /home/user/documents/plans/*). ' +
      'Read or write it, then implement. Do not narrate.'
    );
  }

  const kind = String(taskType || 'mixed').toLowerCase();
  const isDoc = kind === 'document';
  const isChatty = kind === 'chat' || kind === 'question';
  const fileOk = !!deliverySuccess || !!state.fileDelivered;
  const ranOk = !!state.ranAction || !!state.implemented;

  // Document/PDF tasks: require a real file write, not explore/plan theatre.
  if (isDoc) {
    if (!fileOk) {
      return (
        '[internal] Deliver the file now with create_pdf(title, content) or create_document(title, content). ' +
        'Do not claim a download exists until the tool returns ok. Do not narrate this message.'
      );
    }
    return null;
  }

  if (isChatty) return null;

  // Build/debug/git: NEVER finish without a real write_file (shell/python ≠ delivery).
  if (kind === 'build' || kind === 'debug' || kind === 'git') {
    if (!fileOk) {
      return (
        '[internal] No workspace files yet. Call write_file NOW with FULL content under ' +
        '/home/user/projects/<slug>/ (index.html, style.css, script.js, …). ' +
        'Shell, Python open(), and chat dumps do NOT create files. Do not narrate this message.'
      );
    }
    const previewBad = previewFailed || state.previewFailed;
    const previewGood = previewOk || (state.verified && !previewBad);
    // Enterprise: never allow finish without preview ok for build/debug (no step escape hatch)
    if (fileOk && !previewGood && (kind === 'build' || kind === 'debug')) {
      return (
        '[internal] VERIFY owns proof: call preview_project on /home/user/projects/<slug> ' +
        '(or delegate_task agent=verify). If errors, patch_file/write_file then re-preview. ' +
        'Do not claim done until preview_project returns ok. Do not narrate this message.'
      );
    }
    if (fileOk && previewBad) {
      return (
        '[internal] Live preview/debug still has errors. Fix them with patch_file or write_file, then call preview_project again (verify owns this). Do not narrate this message.'
      );
    }
    return null;
  }

  // Run: shell/js/python counts; prefer verifying after.
  if (kind === 'run') {
    if (!ranOk && !fileOk) {
      return (
        '[internal] Run the command with execute_command / execute_code / run_python / run_javascript now. Do not narrate this message.'
      );
    }
    return null;
  }

  // mixed / other
  if (!state.explored && step < 2) {
    return (
      '[internal] Call one inspect tool first (view_tree, read_file, search_web, or http_request), then act. Do not narrate this message.'
    );
  }
  if (!fileOk && !ranOk) {
    return (
      '[internal] Deliver work with tools now (write_file for files; execute_command / run_python / run_javascript for commands). Do not narrate — call tools.'
    );
  }
  return null;
}

function workflowBrief(autoSkillsBrief) {
  // Keep kickoff minimal — identity lives in the system prompt.
  if (autoSkillsBrief) return String(autoSkillsBrief).trim();
  return '';
}

module.exports = {
  CHATRE_AGENT_PROMPT,
  PHASES,
  emptyTodos,
  normalizeTodos,
  applyTodoAction,
  formatTodos,
  recordToolPhase,
  finishGate,
  workflowBrief,
};
