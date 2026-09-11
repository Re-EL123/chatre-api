'use strict';

/**
 * Task-type → allowed tools (server-side enforcement).
 */

const ALWAYS = new Set([
  'todo',
  'todo_write',
  'plan',
  'list_skills',
  'use_skill',
  'ask_user_input',
  'desktop_status',
  'desktop_open',
  'desktop_screenshot',
  'desktop_clipboard_get',
  'desktop_clipboard_set',
  'desktop_notify',
]);

const BY_TYPE = {
  chat: new Set([...ALWAYS]),
  question: new Set([
    ...ALWAYS,
    'search_web',
    'http_request',
    'read_file',
    'list_directory',
    'find_files',
    'search_code',
    'view_tree',
    'get_page_text',
    'navigate',
    'tabs_create',
    'read_page',
  ]),
  research: new Set([
    ...ALWAYS,
    'search_web',
    'http_request',
    'tabs_create',
    'navigate',
    'computer',
    'read_page',
    'find',
    'get_page_text',
    'form_input',
    'read_file',
    'list_directory',
    'find_files',
    'search_code',
    'view_tree',
    'create_document',
  ]),
  browser: new Set([
    ...ALWAYS,
    'search_web',
    'http_request',
    'tabs_create',
    'navigate',
    'computer',
    'read_page',
    'find',
    'form_input',
    'get_page_text',
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_screenshot',
    'browser_read',
    'browser_content',
    'browser_evaluate',
    'browser_wait',
    'browser_scroll',
    'browser',
  ]),
  build: null, // full access
  debug: null,
  document: new Set([
    ...ALWAYS,
    'search_web',
    'http_request',
    'read_file',
    'write_file',
    'append_file',
    'list_directory',
    'create_directory',
    'find_files',
    'search_code',
    'view_tree',
    'create_document',
    'create_pdf',
    'export_document',
    'execute_command',
    'run_javascript',
    'run_python',
  ]),
  git: new Set([
    ...ALWAYS,
    'read_file',
    'list_directory',
    'view_tree',
    'find_files',
    'execute_command',
    'git_init',
    'git_add',
    'git_commit',
    'git_status',
    'git_log',
    'git_push',
  ]),
  run: new Set([
    ...ALWAYS,
    'execute_command',
    'run_javascript',
    'run_python',
    'read_file',
    'list_directory',
    'view_tree',
    'verify_project',
  ]),
  mixed: null,
};

function allowedToolsForTaskType(taskType) {
  const t = String(taskType || 'mixed').toLowerCase();
  const set = BY_TYPE[t];
  if (set == null) return null; // unrestricted
  return set;
}

function assertToolAllowed(tool, taskType, toolsPriority) {
  const name = String(tool || '');
  const allowed = allowedToolsForTaskType(taskType);
  if (!allowed) {
    return { ok: true };
  }
  // Analyst priority tools always allowed if listed
  if (Array.isArray(toolsPriority) && toolsPriority.includes(name)) {
    return { ok: true };
  }
  if (allowed.has(name)) return { ok: true };
  return {
    ok: false,
    error:
      'Tool "' +
      name +
      '" is disabled for task_type=' +
      taskType +
      '. Use: ' +
      [...allowed].slice(0, 24).join(', '),
  };
}

module.exports = {
  ALWAYS,
  BY_TYPE,
  allowedToolsForTaskType,
  assertToolAllowed,
};
