'use strict';

/**
 * Chatre agent loop helpers — todos, phase tracking, finish gates.
 */

const CHATRE_AGENT_PROMPT = `You are Chatre. You use a real browser and a computer workspace to get things done. Finish the user's request fully.

Rules:
- Use tools; do not invent file or page contents.
- When you say you will do something, call the tool in the same turn.
- Keep a short todo list for multi-step work; check items off as you go.
- Verify before you stop. If something fails, fix it and retry.
- Do not ask what to do next while work remains.
- Never mention other products, agents, or internal process names. You are Chatre.
- Do not explain your process to the user. Act, then give a short useful answer.

Browser: browser_navigate → inspect → browser_click/type/press → confirm with browser_read or browser_screenshot. Prefer http_request for plain HTTP.
Computer: execute_command, files, search, git, run_javascript, run_python.

Prefer native tool calls. Fallback: \`\`\`tool JSON blocks.
Be direct.`;

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
    tool === 'browser_navigate' ||
    tool === 'browser_read' ||
    tool === 'browser_content' ||
    tool === 'browser_screenshot' ||
    tool === 'http_request'
  ) {
    s.explored = true;
  }
  if (tool === 'plan' || tool === 'todo') {
    s.planned = true;
  }
  if (
    tool === 'write_file' ||
    tool === 'append_file' ||
    tool === 'create_directory' ||
    tool === 'create_document' ||
    tool === 'execute_command' ||
    tool === 'run_javascript' ||
    tool === 'run_python' ||
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
    tool === 'browser_screenshot' ||
    tool === 'browser_read'
  ) {
    if (tool === 'verify_project') s.verified = true;
    else if (s.implemented) s.verified = true;
  }
  return s;
}

/**
 * Internal model nudge — not shown as product copy.
 * Returns null if OK to finish, or a short continue hint.
 */
function finishGate({ state, todos, step, forcePlan }) {
  if (!forcePlan) return null;
  const open = (todos || []).filter((t) => t.status !== 'done');
  if (open.length) {
    return (
      'Continue: ' +
      open.length +
      ' open todo(s).\n' +
      formatTodos(open) +
      '\nMark done with todo({action:"done", id}), then finish.'
    );
  }
  if (!state.explored && step < 3) {
    return 'Continue: inspect first (view_tree, read_file, browser_navigate, or http_request).';
  }
  if (!state.planned && step < 4) {
    return 'Continue: plan + todo({action:"set", items:[...]}) before finishing.';
  }
  if (state.implemented && !state.verified) {
    return 'Continue: verify (verify_project, execute_command, or browser_read), then finish.';
  }
  if (!state.implemented && step < 5) {
    return 'Continue: deliver the work with tools before finishing.';
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
