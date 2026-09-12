'use strict';

/**
 * Analyst → executor briefing for Chatre.
 * The analyst understands the request and writes a task-specific brief;
 * the executor follows that brief (not a one-size-fits-all loop).
 */

const ANALYST_SYSTEM_PROMPT = `You are Chatre's analysis agent. You do NOT execute tools. Your only job is to understand THIS specific user request and write a precise brief that another Chatre executor agent will follow.

Rules:
- You are Chatre. Never mention other products or agents.
- No flattery. Be direct.
- Do not give the final user-facing answer. Produce an execution brief only.
- Tailor everything to THIS request. Do not use a generic template that would fit any task.
- If the request is a simple greeting or pure chat with no work, set task_type to "chat" and keep the brief minimal (executor should answer directly, no tools).
- If key details are missing and you cannot infer them, set needs_clarification to true and ask ONE short question in clarification_question.

Output ONLY a single JSON object (no markdown fences, no prose outside JSON) with this shape:
{
  "understanding": "1-3 sentences: what the user actually wants",
  "goal": "one-line concrete goal",
  "task_type": "chat|question|research|browser|build|debug|document|git|run|mixed",
  "success_criteria": ["observable checks that prove done"],
  "done_when": "ONE concrete checkable condition (file path exists, command exit 0, etc.)",
  "approach": ["ordered steps unique to this request"],
  "todos": [{"id":"t1","content":"imperative task"}],
  "tools_priority": ["tool names the executor should prefer, in order"],
  "do_not": ["mistakes or overreach to avoid for THIS request"],
  "constraints": ["hard constraints from the user"],
  "needs_clarification": false,
  "clarification_question": "",
  "max_steps": 6,
  "estimated_minutes": 2,
  "executor_brief": "Multi-paragraph instructions written TO the executor: what to do, in what order, how to verify, what done looks like. Specific to this request — not a generic workflow lecture."
}

Be thorough in approach/todos/executor_brief for non-trivial work. For chat/question, keep todos empty and tools_priority empty unless a quick search is truly needed.
Set max_steps low (prefer 3–8). Prefer fewer high-value tools over long loops. Always set done_when to something checkable in the workspace or tool results.`;

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* continue */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* continue */
    }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeBriefing(obj, userMessage) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const todos = Array.isArray(o.todos)
    ? o.todos
        .map((t, i) => {
          if (typeof t === 'string') {
            return { id: 't' + (i + 1), content: t, status: 'pending' };
          }
          if (!t || typeof t !== 'object') return null;
          return {
            id: String(t.id || 't' + (i + 1)),
            content: String(t.content || t.text || ''),
            status: 'pending',
          };
        })
        .filter((t) => t && t.content)
    : [];

  const taskTypeRaw = String(o.task_type || o.taskType || 'mixed').toLowerCase();
  const msg = String(userMessage || '').toLowerCase();
  // Hard overrides — don't let code-mode prefixes or weak LLM classification
  // turn a PDF/book request into research/build theatre.
  let taskType = taskTypeRaw;
  if (/\bpdf\b/.test(msg) || /\b(generate|create|make|write)\b.{0,40}\b(book|report|guide|manual|essay)\b/.test(msg)) {
    taskType = 'document';
  } else if (/^\s*(hi|hello|hey|thanks|thank you)\b/.test(msg) && msg.length < 40) {
    taskType = 'chat';
  }

  const needsClarification = o.needs_clarification === true || o.needsClarification === true;
  const maxSteps = Math.min(
    Math.max(Number(o.max_steps || o.maxSteps || o.budget_steps) || 0, 0),
    12,
  );

  let toolsPriority = Array.isArray(o.tools_priority)
    ? o.tools_priority.map(String)
    : Array.isArray(o.toolsPriority)
      ? o.toolsPriority.map(String)
      : [];
  if (taskType === 'document') {
    if (/\bpdf\b/.test(msg)) {
      toolsPriority = ['create_pdf', 'create_document'].concat(
        toolsPriority.filter((t) => t !== 'create_pdf' && t !== 'create_document'),
      );
    } else if (!toolsPriority.length) {
      toolsPriority = ['create_document', 'create_pdf'];
    }
  }

  const doNot = Array.isArray(o.do_not)
    ? o.do_not.map(String)
    : Array.isArray(o.doNot)
      ? o.doNot.map(String)
      : [];
  if (taskType === 'document') {
    [
      'Do not invent download URLs',
      'Do not dump Python/fpdf or /mnt/data paths',
      'Do not claim a file exists without a successful create_pdf/create_document tool result',
      'Do not explore the web unless facts are missing — deliver the file',
    ].forEach((rule) => {
      if (doNot.indexOf(rule) < 0) doNot.push(rule);
    });
  }

  let successCriteria = Array.isArray(o.success_criteria)
    ? o.success_criteria.map(String)
    : Array.isArray(o.successCriteria)
      ? o.successCriteria.map(String)
      : [];
  const doneWhenRaw = String(o.done_when || o.doneWhen || '').trim();
  // Lazy require to avoid cycles; deriveDoneWhen is pure.
  const { deriveDoneWhen } = require('./smart-agent');
  const doneWhen =
    doneWhenRaw ||
    deriveDoneWhen(
      { success_criteria: successCriteria, task_type: taskType },
      userMessage,
      taskType,
    );
  if (!successCriteria.length && doneWhen) successCriteria = [doneWhen];

  return {
    understanding: String(o.understanding || '').trim(),
    goal: String(o.goal || '').trim() || String(userMessage || '').slice(0, 200),
    task_type: taskType,
    success_criteria: successCriteria,
    done_when: doneWhen,
    approach: Array.isArray(o.approach) ? o.approach.map(String) : [],
    todos,
    tools_priority: toolsPriority,
    do_not: doNot,
    constraints: Array.isArray(o.constraints) ? o.constraints.map(String) : [],
    needs_clarification: needsClarification,
    clarification_question: String(
      o.clarification_question || o.clarificationQuestion || '',
    ).trim(),
    executor_brief: String(o.executor_brief || o.executorBrief || '').trim(),
    max_steps: maxSteps || undefined,
    estimated_minutes: Number(o.estimated_minutes || o.estimatedMinutes) || undefined,
  };
}

/**
 * Build the message the executor receives — the analyst's custom prompt.
 */
function formatExecutorPrompt(briefing, userMessage) {
  const b = briefing || {};
  const lines = [
    '# Executor orders (from Chatre analysis — follow these, not a generic script)',
    '',
    '## User request',
    String(userMessage || '').trim(),
    '',
    '## Understanding',
    b.understanding || '(see user request)',
    '',
    '## Goal',
    b.goal || '(complete the user request)',
    '',
    '## Task type',
    b.task_type || 'mixed',
  ];

  if (b.done_when) {
    lines.push('', '## Done when (hard stop condition)', b.done_when);
  }
  if (b.success_criteria && b.success_criteria.length) {
    lines.push('', '## Success criteria (must meet before finishing)');
    b.success_criteria.forEach((c, i) => lines.push(i + 1 + '. ' + c));
  }
  if (b.approach && b.approach.length) {
    lines.push('', '## Approach for THIS task');
    b.approach.forEach((c, i) => lines.push(i + 1 + '. ' + c));
  }
  if (b.tools_priority && b.tools_priority.length) {
    lines.push(
      '',
      '## Preferred tools (in order)',
      b.tools_priority.join(', '),
    );
  }
  if (b.do_not && b.do_not.length) {
    lines.push('', '## Do not');
    b.do_not.forEach((c) => lines.push('- ' + c));
  }
  if (b.constraints && b.constraints.length) {
    lines.push('', '## Constraints');
    b.constraints.forEach((c) => lines.push('- ' + c));
  }
  if (b.executor_brief) {
    lines.push('', '## Detailed brief', b.executor_brief);
  }
  lines.push(
    '',
    '## Rules for you (executor)',
    '- Execute this brief thoroughly. Adapt tool use to THESE orders — do not run a generic explore→plan→same-path loop if it does not fit.',
    '- Use todo_write / todo to track the listed todos; mark each done when finished.',
    '- Verify against done_when / success criteria with real workspace evidence before you stop.',
    '- Prefer workspace tools: view_tree, list_directory, read_file, write_file under /home/user/documents or /home/user/projects.',
    '- First action for delivery tasks must be a tool call, not a long plan essay.',
    '- Do not narrate process. Act, then give a short useful final answer (prefix with <answer> when done).',
    '- Never invent results. If blocked, say what you need.',
  );
  return lines.join('\n');
}

function analystUserPrompt(userMessage, historySnippet) {
  let prompt =
    'Analyze this user request and produce the JSON briefing.\n\nUser request:\n' +
    String(userMessage || '').trim();
  if (historySnippet) {
    prompt +=
      '\n\nRecent conversation context (may help):\n' +
      String(historySnippet).slice(0, 3000);
  }
  return prompt;
}

function historySnippet(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  return messages
    .slice(-6)
    .map((m) => {
      const role = m && m.role ? m.role : 'user';
      const content = String((m && m.content) || '').slice(0, 400);
      return role + ': ' + content;
    })
    .join('\n');
}

module.exports = {
  ANALYST_SYSTEM_PROMPT,
  extractJsonObject,
  normalizeBriefing,
  formatExecutorPrompt,
  analystUserPrompt,
  historySnippet,
};
