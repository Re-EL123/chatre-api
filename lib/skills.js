'use strict';

/**
 * Auto-select skills from the user prompt.
 */
function detectSkills(text) {
  const t = String(text || '').toLowerCase();
  const skills = new Set();

  if (
    /\b(build|code|implement|scaffold|app|website|script|function|api|refactor|debug|fix)\b/.test(
      t,
    )
  ) {
    skills.add('coding');
  }
  if (/\b(document|readme|markdown|docs|write.?up|spec)\b/.test(t)) {
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
    'Skill coding: explore → plan+todos → write_file complete files → verify_project/execute_command → README.',
  documents:
    'Skill documents: outline → todo set → create_document under /home/user/documents/ → verify.',
  git: 'Skill git: git_init if needed → git_add → git_commit → git_status/git_log → git_push when asked.',
  debugging:
    'Skill debugging: reproduce with execute_command → read_file/search_code → minimal write_file fix → re-verify.',
  research:
    'Skill research: view_tree → list_directory → find_files/search_code → read_file before any edits.',
  project:
    'Skill project: explore → plan+todos → implement atomically → verify_project → document → git_commit.',
  browser:
    'Skill browser: tabs_create → navigate → read_page/get_page_text/screenshot → computer/form_input with coords or refs → search_web for research. Always pass tab_id.',
  computer:
    'Skill computer: todo_write for plans; execute_command and files for workspace; search_web/http_request for network; browser tools for interactive web; desktop_* for real OS (open/screenshot/clipboard) when companion is online.',
};

function skillBrief(names) {
  return names.map((n) => SKILL_GUIDES[n] || n).join('\n');
}

module.exports = { detectSkills, skillBrief, SKILL_GUIDES };
