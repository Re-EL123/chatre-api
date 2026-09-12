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
        };
      }
      if (!item || typeof item !== 'object') return null;
      return {
        id: String(item.id || 't' + (i + 1)),
        content: String(item.content || item.text || item.title || ''),
        status: item.status === 'done' || item.status === 'completed' ? 'done' : 'pending',
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
    .map((t) => (t.status === 'done' ? '- [x] ' : '- [ ] ') + t.id + ': ' + t.content)
    .join('\n');
}

function recordToolPhase(state, tool) {
  const s = state || {
    explored: false,
    planned: false,
    implemented: false,
    verified: false,
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
  if (
    tool === 'write_file' ||
    tool === 'append_file' ||
    tool === 'create_directory' ||
    tool === 'create_document' ||
    tool === 'create_pdf' ||
    tool === 'execute_command' ||
    tool === 'run_javascript' ||
    tool === 'run_python' ||
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
    s.implemented = true;
  }
  if (
    tool === 'verify_project' ||
    tool === 'execute_command' ||
    tool === 'run_javascript' ||
    tool === 'run_python' ||
    tool === 'computer' ||
    tool === 'get_page_text' ||
    tool === 'read_page' ||
    tool === 'browser_screenshot' ||
    tool === 'browser_read'
  ) {
    if (tool === 'verify_project') s.verified = true;
    else if (s.implemented) s.verified = true;
  }
  return s;
}

/**
 * Internal model nudge — never show as product/chat copy.
 * Returns null if OK to finish, or a short continue hint for the model only.
 */
function finishGate({ state, todos, step, forcePlan, taskType }) {
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

  const kind = String(taskType || 'mixed').toLowerCase();
  const isDoc = kind === 'document';
  const isChatty = kind === 'chat' || kind === 'question';

  // Document/PDF tasks: require a real file write, not explore/plan theatre.
  if (isDoc) {
    if (!state.implemented && step < 6) {
      return (
        '[internal] Deliver the file now with create_pdf(title, content) or create_document(title, content). ' +
        'Do not claim a download exists until the tool returns ok. Do not narrate this message.'
      );
    }
    return null;
  }

  if (isChatty) return null;

  // Coding / mixed: light gates only early in the run.
  if (!state.explored && step < 2) {
    return (
      '[internal] Call one inspect tool first (view_tree, read_file, search_web, or http_request), then act. Do not narrate this message.'
    );
  }
  if (!state.planned && step < 3 && (kind === 'build' || kind === 'debug')) {
    return (
      '[internal] Call todo_write or plan with concrete steps, then implement with tools. Do not narrate this message.'
    );
  }
  if (state.implemented && !state.verified && (kind === 'build' || kind === 'debug')) {
    return (
      '[internal] Verify with verify_project or execute_command, then finish with <answer>. Do not narrate this message.'
    );
  }
  if (!state.implemented && step < 4 && (kind === 'build' || kind === 'debug' || kind === 'run')) {
    return (
      '[internal] Deliver work with tools (write_file / execute_command / etc.) before finishing. Do not narrate this message.'
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
