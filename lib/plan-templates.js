'use strict';

/**
 * Plan templates — seed sparse analyst briefings (mirrors FE plan-templates.js).
 */

const TEMPLATES = [
  {
    id: 'research',
    label: 'Research X',
    task_type: 'research',
    understanding: 'User wants a sourced research summary on a topic.',
    goal: 'Produce a concise research brief with citations',
    success_criteria: [
      'Use search_web (not a search-engine site)',
      'Open 2–3 strong sources and extract facts',
      'Final answer cites [web:N] ids',
    ],
    approach: [
      'Clarify topic if vague',
      'search_web with 2–3 focused queries',
      'Navigate top results; get_page_text / read_page',
      'Synthesize short original summary with citations',
    ],
    tools_priority: ['search_web', 'tabs_create', 'navigate', 'get_page_text'],
    max_steps: 10,
    executor_brief:
      'Research the user topic thoroughly. Prefer search_web, then read primary pages. Cite tool ids. Do not invent sources.',
  },
  {
    id: 'fill-form',
    label: 'Fill form Y',
    task_type: 'browser',
    understanding: 'User wants a web form filled and submitted carefully.',
    goal: 'Complete the form accurately with confirmations for risky submits',
    success_criteria: [
      'Locate form fields via read_page/find',
      'Fill with provided values only',
      'Ask confirmation before irreversible submit',
    ],
    approach: [
      'Navigate to the form URL',
      'read_page interactive; map fields',
      'form_input / computer type for each field',
      'Pause for login/2FA if needed',
      'Confirm before submit',
    ],
    tools_priority: [
      'tabs_create',
      'navigate',
      'read_page',
      'find',
      'form_input',
      'computer',
      'await_login',
    ],
    max_steps: 14,
    executor_brief:
      'Fill the form using refs. Never invent personal data. Use await_login if auth walls appear. Confirm before submit/purchase.',
  },
  {
    id: 'build',
    label: 'Build Z',
    task_type: 'build',
    understanding: 'User wants a small software artifact built and verified.',
    goal: 'Implement, verify, and report paths',
    success_criteria: [
      'Explore workspace first',
      'Implement requested files',
      'Run verify_project or equivalent checks',
    ],
    approach: [
      'view_tree / list_directory',
      'plan + todos',
      'write_file changes',
      'verify_project / execute_command',
      'Summarize how to run',
    ],
    tools_priority: [
      'view_tree',
      'read_file',
      'write_file',
      'todo_write',
      'verify_project',
      'execute_command',
    ],
    max_steps: 16,
    executor_brief:
      'Build exactly what was asked. Explore first, implement, verify, then finish with file paths and run instructions.',
  },
  {
    id: 'document',
    label: 'Write document',
    task_type: 'document',
    understanding: 'User wants a downloadable document or PDF.',
    goal: 'Produce a real file under /home/user/documents',
    success_criteria: [
      'create_document or create_pdf succeeds',
      'File path reported to the user',
    ],
    approach: [
      'Decide markdown vs PDF from the request',
      'Draft structured content',
      'create_document or create_pdf',
      'Confirm path in Files panel',
    ],
    tools_priority: ['create_document', 'create_pdf'],
    max_steps: 6,
    executor_brief:
      'Deliver one real downloadable file via create_document or create_pdf under /home/user/documents. Do not invent download links.',
  },
];

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

function templateForTaskType(taskType) {
  const t = String(taskType || '').toLowerCase();
  if (t === 'research') return getTemplate('research');
  if (t === 'browser') return getTemplate('fill-form');
  if (t === 'build' || t === 'debug' || t === 'git' || t === 'run' || t === 'mixed') {
    return getTemplate('build');
  }
  if (t === 'document') return getTemplate('document');
  return null;
}

function briefingFromTemplate(id, userGoal) {
  const t = getTemplate(id);
  if (!t) return null;
  const goal = String(userGoal || t.goal || '').trim();
  return {
    understanding: t.understanding,
    goal: goal || t.goal,
    task_type: t.task_type,
    success_criteria: (t.success_criteria || []).slice(),
    approach: (t.approach || []).slice(),
    tools_priority: (t.tools_priority || []).slice(),
    do_not: [],
    constraints: [],
    needs_clarification: false,
    clarification_question: '',
    max_steps: t.max_steps,
    executor_brief: t.executor_brief + (goal ? '\n\nUser goal: ' + goal : ''),
    todos: (t.approach || []).map((step, i) => ({
      id: 't' + (i + 1),
      content: step,
      status: 'pending',
    })),
    template_id: t.id,
  };
}

function isSparseBriefing(briefing) {
  const b = briefing || {};
  const hasText = !!(
    String(b.understanding || '').trim() ||
    String(b.executor_brief || '').trim()
  );
  const hasSteps =
    (Array.isArray(b.approach) && b.approach.length) ||
    (Array.isArray(b.todos) && b.todos.length) ||
    (Array.isArray(b.plan_steps) && b.plan_steps.length);
  return !hasText || !hasSteps;
}

/**
 * Fill empty analyst fields from a matching template without wiping good data.
 */
function enrichBriefing(briefing, userMessage) {
  const b = briefing && typeof briefing === 'object' ? { ...briefing } : {};
  const msg = String(userMessage || '').trim();
  if (!isSparseBriefing(b) && String(b.executor_brief || '').trim()) {
    return b;
  }
  const tpl =
    (b.template_id && getTemplate(b.template_id)) ||
    templateForTaskType(b.task_type) ||
    null;
  if (!tpl) {
    if (!String(b.understanding || '').trim()) {
      b.understanding = 'Execute the user request directly.';
    }
    if (!String(b.executor_brief || '').trim()) {
      b.executor_brief =
        'Complete the user request thoroughly. Match tools to the request — do not use a generic script.' +
        (msg ? '\n\nUser request: ' + msg.slice(0, 500) : '');
    }
    if (!Array.isArray(b.approach) || !b.approach.length) {
      b.approach = ['Inspect what is needed', 'Do the work with tools', 'Verify and summarize'];
    }
    if (!Array.isArray(b.todos) || !b.todos.length) {
      b.todos = b.approach.map((step, i) => ({
        id: 't' + (i + 1),
        content: step,
        status: 'pending',
      }));
    }
    if (!Array.isArray(b.success_criteria) || !b.success_criteria.length) {
      b.success_criteria = [b.done_when || 'Goal completed with workspace evidence'];
    }
    return b;
  }
  const seeded = briefingFromTemplate(tpl.id, b.goal || msg);
  return {
    ...seeded,
    ...b,
    understanding: String(b.understanding || '').trim() || seeded.understanding,
    goal: String(b.goal || '').trim() || seeded.goal,
    task_type: b.task_type || seeded.task_type,
    success_criteria:
      Array.isArray(b.success_criteria) && b.success_criteria.length
        ? b.success_criteria
        : seeded.success_criteria,
    approach:
      Array.isArray(b.approach) && b.approach.length ? b.approach : seeded.approach,
    todos: Array.isArray(b.todos) && b.todos.length ? b.todos : seeded.todos,
    tools_priority:
      Array.isArray(b.tools_priority) && b.tools_priority.length
        ? b.tools_priority
        : seeded.tools_priority,
    executor_brief:
      String(b.executor_brief || '').trim() || seeded.executor_brief,
    max_steps: b.max_steps || seeded.max_steps,
    template_id: b.template_id || seeded.template_id,
  };
}

module.exports = {
  TEMPLATES,
  getTemplate,
  templateForTaskType,
  briefingFromTemplate,
  isSparseBriefing,
  enrichBriefing,
};
