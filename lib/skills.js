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
    'Skill coding: inspect with view_tree/list_directory/read_file, plan, write_file complete files, verify with execute_command or verify_project, add README via create_document/write_file.',
  documents:
    'Skill documents: outline then create_document with polished markdown under /home/user/documents/.',
  git: 'Skill git: git_init if needed, git_add (path or .), git_commit with clear message, git_status/git_log, git_push when asked.',
  debugging:
    'Skill debugging: reproduce with execute_command, read_file/search_code, minimal write_file fix, re-verify.',
  research:
    'Skill research: view_tree, list_directory, find_files, search_code, read_file before edits.',
  project:
    'Skill project: plan → build with write_file → verify_project → document → git_commit/git_push.',
};

function skillBrief(names) {
  return names.map((n) => SKILL_GUIDES[n] || n).join('\n');
}

module.exports = { detectSkills, skillBrief, SKILL_GUIDES };
