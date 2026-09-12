'use strict';

/**
 * Auto-select skills from the user prompt.
 */
function detectSkills(text) {
  const t = String(text || '').toLowerCase();
  const skills = new Set();

  if (
    /\b(build|code|implement|scaffold|app|website|script|function|api|refactor|fix)\b/.test(
      t,
    )
  ) {
    skills.add('coding');
  }
  if (/\b(document|readme|markdown|docs|write.?up|spec|pdf|report|guide|manual|essay|book|proposal|slide)\b/.test(t)) {
    skills.add('documents');
  }
  if (/\b(git|commit|push|repo|repository|version control)\b/.test(t)) {
    skills.add('git');
  }
  if (/\b(debug|error|bug|failing|stack.?trace)\b/.test(t)) {
    skills.add('debugging');
  }
  if (/\b(explore|inspect|search|find files|research)\b/.test(t)) {
    skills.add('research');
  }
  if (
    /\b(browser|navigate|click|website|web page|url|screenshot|fill form|login page)\b/.test(
      t,
    ) ||
    /https?:\/\//.test(t)
  ) {
    skills.add('browser');
  }
  if (
    /\b(computer|desktop|shell|terminal|http request|curl|download|os|system)\b/.test(
      t,
    )
  ) {
    skills.add('computer');
  }
  if (
    /\b(byok|api key|openrouter|anthropic|openai|gemini|bring your own)\b/.test(
      t,
    )
  ) {
    skills.add('byok_setup');
  }
  if (
    /\b(web research|research the web|cite sources|summarize articles|fetch.?url)\b/.test(
      t,
    )
  ) {
    skills.add('web_research');
  }
  if (
    /\b(login|sign in|2fa|captcha|fill (the )?form|checkout|submit form)\b/.test(
      t,
    )
  ) {
    skills.add('form_workflow');
  }
  if (/\b(pull request|pr\b|code review|patch|commit message)\b/.test(t)) {
    skills.add('code_pr');
  }
  if (/\b(csv|spreadsheet|table data|cleanup data|data clean)\b/.test(t)) {
    skills.add('data_cleanup');
  }
  if (
    /\b(network error|console error|ops debug|site broken|har\b|failed request)\b/.test(
      t,
    )
  ) {
    skills.add('ops_debug');
  }
  if (
    /\b(password|secret|credential|api token|never share|account safe)\b/.test(
      t,
    )
  ) {
    skills.add('account_safe');
  }
  if (/\b(remember|memory|note that|remind me|schedule)\b/.test(t)) {
    skills.add('memory_schedule');
  }
  if (
    /\b(shell|terminal|npm (test|run|install)|pytest|make |cargo |go test|debug (the )?build|exit code)\b/.test(
      t,
    )
  ) {
    skills.add('shell_debug');
  }
  if (skills.has('coding') && (skills.has('documents') || skills.has('git'))) {
    skills.add('project');
  }
  if (!skills.size && /\b(create|make|write|plan)\b/.test(t)) {
    skills.add('coding');
  }
  return [...skills];
}

const SKILL_GUIDES = {
  coding:
    'Skill coding: explore → plan+todos → write_file or patch_file → verify_project/execute_command → README.',
  documents:
    'Skill documents: for PDF requests call create_pdf(title, content) with the FULL body text under /home/user/documents/; for markdown use create_document. Never invent download links or dump Python/fpdf. Only claim a file exists after the tool returns ok with a path.',
  git: 'Skill git: git_init if needed → git_add → git_commit → git_status/git_log → git_push when asked.',
  debugging:
    'Skill debugging: reproduce with execute_command → read_file/search_code → minimal patch_file fix → re-verify.',
  research:
    'Skill research: view_tree → list_directory → find_files/search_code → read_file before any edits.',
  project:
    'Skill project: explore → plan+todos → implement atomically → verify_project → document → git_commit.',
  browser:
    'Skill browser: tabs_create → navigate → read_page/get_page_text/screenshot → computer/form_input with coords or refs → search_web for research. Always pass tab_id. Use browser_network/browser_console when debugging.',
  computer:
    'Skill computer: todo_write for plans; execute_command and files for workspace; search_web/http_request/fetch_url for network; browser tools for interactive web; desktop_* (incl. type/hotkey/click) for real OS when companion is online.',
  byok_setup:
    'Skill byok_setup: confirm user is signed in → save provider key in Settings BYOK (or ask them to) → test_connection(provider) → pick provider:model → run a tiny chat. Never echo API keys.',
  web_research:
    'Skill web_research: search_web (max 3 queries) → rank results → fetch_url on top sources → synthesize with citations [web:N]. Use browser only if JS/login required.',
  form_workflow:
    'Skill form_workflow: navigate → list_frames/switch_frame if needed → read_page → form_input/computer → await_login on walls → screenshot verify. Do not invent credentials.',
  code_pr:
    'Skill code_pr: explore → patch_file for surgical edits → verify → git_status → git_add → git_commit with why-focused message. git_push only if user asked.',
  data_cleanup:
    'Skill data_cleanup: csv_read → csv_query/filter → csv_write cleaned file → upload_artifact. Prefer CSV tools over ad-hoc Python unless needed.',
  ops_debug:
    'Skill ops_debug: reproduce → browser_network (failed_only) + browser_console → identify failing URL/script → minimal fix or report. Use ocr_image if text is only in screenshots.',
  account_safe:
    'Skill account_safe: never invent or log passwords/API keys; use await_login / ask_user_input; never echo BYOK secrets; prefer memory_set only for non-secret preferences.',
  memory_schedule:
    'Skill memory_schedule: memory_set/get for durable user notes; remind/schedule_create for timed notes; schedule_due to deliver; schedule_list/cancel to manage.',
  shell_debug:
    'Skill shell_debug: reproduce with execute_command (streamed) → read exit/code/duration → capture logs → patch_file minimal fix → re-run. Prefer workspace mode; sandbox for untrusted; local/desktop_exec only with approved=true. Use shell_open/write/read for interactive installers; execute_command_cancel to stop hangs. On needs_input, pause for the user.',
};

function skillBrief(names) {
  return names.map((n) => SKILL_GUIDES[n] || n).join('\n');
}

module.exports = { detectSkills, skillBrief, SKILL_GUIDES };
