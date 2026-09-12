'use strict';

/**
 * Soft task-type bias prompts.
 * Hierarchy: named agent (permissions+mission) > skills > task-type bias.
 * Never use these to override named-agent permissions.
 */

const ROLES = {
  browser: {
    name: 'browser',
    label: 'Browser bias',
    prompt: `Soft bias: prefer browser tools when the brief needs live pages.
tabs_create → navigate → read_page/find → computer/form_input with refs.
Never bypass CAPTCHA. Cite [web:N] / [screenshot:N].`,
  },
  coder: {
    name: 'coder',
    label: 'Code bias',
    prompt: `Soft bias: prefer workspace files + verify.
view_tree/read_file → todos → write_file → preview_project.
For UI apply Design skill. Do not browse unless required.`,
  },
  explorer: {
    name: 'explore',
    label: 'Explore bias',
    prompt: `Soft bias: read-only mapping with find_files / search_code / read_file.
Never write or mutate. Honor thoroughness. Return absolute paths.`,
  },
  researcher: {
    name: 'researcher',
    label: 'Research bias',
    prompt: `Soft bias: search_web + citations [web:N]. Prefer multiple sources.
Do not modify files unless the brief asks for a document.`,
  },
  writer: {
    name: 'writer',
    label: 'Document bias',
    prompt: `Soft bias: create_pdf / create_document / write_file with full content.
Apply Design skill for hierarchy. Never claim a file without a tool ok.`,
  },
  verify: {
    name: 'verify',
    label: 'Verify bias',
    prompt: `Soft bias: preview_project / verify_project before claiming done.
List concrete errors; prefer minimal patches.`,
  },
  general: {
    name: 'general',
    label: 'General bias',
    prompt: `Soft bias: follow the briefing. Adapt tools to the goal — no generic loops.`,
  },
};

function roleForTaskType(taskType) {
  const t = String(taskType || 'mixed').toLowerCase();
  if (t === 'browser') return 'browser';
  if (t === 'build' || t === 'debug' || t === 'run' || t === 'git') return 'coder';
  if (t === 'research') return 'explorer';
  if (t === 'question') return 'researcher';
  if (t === 'document') return 'writer';
  if (t === 'chat') return 'general';
  return 'general';
}

function subagentPrompt(taskType) {
  const role = roleForTaskType(taskType);
  return ROLES[role] || ROLES.general;
}

/**
 * Soft bias string for injection under a named agent (never overrides permissions).
 */
function taskTypeBiasFor(namedAgent, taskType) {
  const agent = String((namedAgent && namedAgent.name) || namedAgent || 'build').toLowerCase();
  // Named explore/plan/verify already define mission — skip conflicting bias
  if (agent === 'explore' || agent === 'plan' || agent === 'verify') {
    return '';
  }
  const role = subagentPrompt(taskType);
  return role.prompt || '';
}

module.exports = { ROLES, roleForTaskType, subagentPrompt, taskTypeBiasFor };
