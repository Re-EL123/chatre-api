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
  'await_login',
  'list_frames',
  'switch_frame',
  'desktop_status',
  'desktop_open',
  'desktop_screenshot',
  'desktop_clipboard_get',
  'desktop_clipboard_set',
  'desktop_notify',
  'desktop_type',
  'desktop_hotkey',
  'desktop_click',
  'memory_get',
  'memory_set',
  'memory_delete',
  'schedule_create',
  'remind',
  'schedule_list',
  'schedule_cancel',
  'schedule_due',
  'test_connection',
  'fetch_url',
  'execute_command_cancel',
  'shell_open',
  'shell_write',
  'shell_read',
  'shell_close',
]);

const BY_TYPE = {
  chat: new Set([...ALWAYS]),
  question: new Set([
    ...ALWAYS,
    'search_web',
    'http_request',
    'fetch_url',
    'download_file',
    'read_file',
    'list_directory',
    'find_files',
    'search_code',
    'view_tree',
    'get_page_text',
    'navigate',
    'tabs_create',
    'read_page',
    'csv_read',
    'csv_query',
  ]),
  research: new Set([
    ...ALWAYS,
    'search_web',
    'http_request',
    'fetch_url',
    'download_file',
    'upload_artifact',
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
    'csv_read',
    'csv_query',
    'csv_write',
    'browser_network',
    'browser_console',
    'ocr_image',
  ]),
  browser: new Set([
    ...ALWAYS,
    'search_web',
    'http_request',
    'fetch_url',
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
    'browser_network',
    'browser_console',
    'ocr_image',
    'download_file',
  ]),
  document: new Set([
    ...ALWAYS,
    'search_web',
    'http_request',
    'fetch_url',
    'read_file',
    'write_file',
    'append_file',
    'patch_file',
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
    'csv_read',
    'csv_write',
    'csv_query',
    'upload_artifact',
    'download_file',
  ]),
  git: new Set([
    ...ALWAYS,
    'read_file',
    'list_directory',
    'view_tree',
    'find_files',
    'execute_command',
    'patch_file',
    'write_file',
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
    'execute_command_cancel',
    'shell_open',
    'shell_write',
    'shell_read',
    'shell_close',
    'run_javascript',
    'run_python',
    'read_file',
    'list_directory',
    'view_tree',
    'verify_project',
    'browser_network',
    'browser_console',
    'desktop_exec',
    'desktop_pty',
  ]),
  build: null, // full access
  debug: null,
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
