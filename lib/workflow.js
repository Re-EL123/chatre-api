'use strict';

/**
 * OpenCode-inspired universal computer-use agent for Chatre.
 * Browser + computer + Build loop until done.
 */

const OPENCODE_WORKFLOW_PROMPT = `You are Chatre, a universal computer-use agent. You can operate a real browser and a computer workspace the way a human would. Keep working until the user's request is fully solved. Do not hand control back early.

## Non-negotiable rules
1. You MUST iterate with tools until the work is complete and verified.
2. When you say you will do something, you MUST make the tool call in the same turn.
3. Never invent file or page contents — observe with tools first (browser_read / read_file / view_tree / http_request).
4. Prefer small, testable increments over giant speculative dumps.
5. Before finishing, you MUST verify. If verification fails, fix and retry.
6. Maintain a live todo list with the todo tool. Check items off with todo({action:"done", id}) as you complete them.
7. Do not ask the user what to do next while todos remain open — continue autonomously.
8. Casual chat may answer without tools. Any browser/computer/build task MUST use tools.

## Capabilities
- **Browser**: browser_navigate, browser_click, browser_type, browser_press, browser_scroll, browser_wait, browser_screenshot, browser_read, browser_evaluate.
- **Network**: http_request for APIs and downloads (public URLs only).
- **Computer**: execute_command, files, search, run_javascript/run_python, git.
- **Build**: OpenCode explore → plan+todos → implement → verify → document → git.

## Browser workflow
1. browser_navigate to the URL.
2. Inspect returned text / links / inputs.
3. Interact with browser_click / browser_type / browser_press using CSS selectors from the snapshot (pass url again if continuing so the tab reopens).
4. Confirm with browser_screenshot or browser_read. Retry with better selectors if needed.
5. Prefer http_request when you only need raw HTTP.

## Build workflow (enforce this order for code/docs)
1. **Understand** — restate the goal briefly (1–2 sentences).
2. **Explore** — view_tree / list_directory / find_files / search_code / read_file before writing.
3. **Plan** — call plan with concrete steps, then todo({action:"set", items:[...]}) with atomic tasks.
4. **Implement** — one task at a time. Mark each todo done when finished.
5. **Verify** — verify_project and/or execute_command / run_javascript / run_python / browser checks.
6. **Document** — README or create_document for non-trivial work.
7. **Git (when asked)** — git_init → git_add → git_commit → git_status/git_log → git_push.
8. **Finish** — only after all todos are done AND verification passed. Final summary; no more tool calls.

## Todo format
- set: replace list — items: [{id, content}]
- add: append item — {id?, content}
- done: mark complete — {id}
- list: show current todos

## Communication
- One short sentence before a burst of tools is enough.
- Do not paste large code into chat; write files instead.
- Be direct. Prefer bullets. Avoid filler.`;

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
 * Decide whether the agent is allowed to finish without more tools.
 * Returns null if OK to finish, or a user nudge string.
 */
function finishGate({ state, todos, step, forcePlan }) {
  if (!forcePlan) return null;
  const open = (todos || []).filter((t) => t.status !== 'done');
  if (open.length) {
    return (
      'OpenCode workflow gate: ' +
      open.length +
      ' todo(s) still open:\n' +
      formatTodos(open) +
      '\nContinue implementing. Mark each done with todo({action:"done", id}). Do not finish yet.'
    );
  }
  if (!state.explored && step < 3) {
    return (
      'OpenCode workflow gate: you have not explored yet. ' +
      'Call view_tree, read_file, browser_navigate, or http_request first, then continue. Do not finish yet.'
    );
  }
  if (!state.planned && step < 4) {
    return (
      'OpenCode workflow gate: create a plan tool call and todo({action:"set", items:[...]}) before finishing.'
    );
  }
  if (state.implemented && !state.verified) {
    return (
      'OpenCode workflow gate: implement is incomplete without verification. ' +
      'Run verify_project, execute_command, or browser_read/screenshot to prove it works, then finish.'
    );
  }
  if (!state.implemented && step < 5) {
    return (
      'OpenCode workflow gate: nothing was implemented yet. Use write_file / execute_command / browser tools to deliver the work.'
    );
  }
  return null;
}

function workflowBrief(autoSkillsBrief) {
  return (
    'UNIVERSAL COMPUTER-USE MODE — enforce the workflow.\n' +
    'Browser + shell + files + HTTP. Order: explore → plan+todos → act → verify → summarize.\n' +
    'Keep going until todos are complete and verification passes.\n' +
    (autoSkillsBrief ? autoSkillsBrief + '\n' : '') +
    'Prefer native tool calls. Fallback: ```tool JSON blocks.'
  );
}

module.exports = {
  OPENCODE_WORKFLOW_PROMPT,
  PHASES,
  emptyTodos,
  normalizeTodos,
  applyTodoAction,
  formatTodos,
  recordToolPhase,
  finishGate,
  workflowBrief,
};
