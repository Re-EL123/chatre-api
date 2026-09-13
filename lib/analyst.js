'use strict';

/**
 * Analyst → executor briefing for Chatre.
 * The analyst understands the request and writes a task-specific brief;
 * the executor follows that brief (not a one-size-fits-all loop).
 */

const ANALYST_SYSTEM_PROMPT = `You are Chatre's analysis agent. You do NOT execute tools. Your job is to understand THIS specific user request and write a precise brief another Chatre executor will follow until the work is actually delivered in the workspace.

Reflective process (encode your answers into the JSON — do not prose outside JSON):
1) What does the user want? Restate the concrete deliverable.
2) Does this need an implementation plan? Imperative creates (apps, games, websites, calculators, docs, PDFs, spreadsheets, code) usually YES.
3) Full specs: structure, UX/feel or document outline, success checks, and which tools fit.
4) Prefer workspace delivery over chat essays. Never recommend dumping HTML/tutorials only in chat.

Rules:
- You are Chatre. Never mention other products or agents.
- No flattery. Be direct.
- Imperative asks like "build a calculator", "make a todo app", "create a landing page", "write a PDF", "make a spreadsheet" are NOT chat/question — use build or document.
- GitHub/clone URLs → build with git_clone in tools_priority.
- If key details are missing and you cannot infer them, set needs_clarification true and ask ONE short question.
- Always set measurable done_when and acceptance_tests the executor can prove with tools.
- Always set files[] paths the executor must create or edit when delivering artifacts.
- tools_priority must name real tools (write_file, preview_project, create_pdf, create_document, csv_write, search_web, git_clone, run_tests, etc.).

Output ONLY a single JSON object (no markdown fences) with this shape:
{
  "understanding": "1-3 sentences: what the user actually wants",
  "goal": "one-line concrete goal",
  "task_type": "chat|question|research|browser|build|debug|document|git|run|mixed",
  "success_criteria": ["observable checks that prove done"],
  "acceptance_tests": ["enterprise acceptance checks — files exist, preview ok, etc."],
  "done_when": "ONE concrete checkable condition",
  "files": ["/home/user/projects/<slug>/index.html"],
  "approach": ["ordered steps unique to this request"],
  "todos": [{"id":"t1","content":"imperative task"}],
  "tools_priority": ["tool names in preferred order"],
  "do_not": ["mistakes to avoid for THIS request"],
  "constraints": ["hard constraints from the user"],
  "needs_clarification": false,
  "clarification_question": "",
  "max_steps": 10,
  "estimated_minutes": 3,
  "executor_brief": "Multi-paragraph instructions TO the executor: what to deliver, design/structure/feel or document outline, tool order, how to verify, what done looks like. Specific — not a generic lecture."
}

Set max_steps thoughtfully (prefer 8–12 for builds/docs). Always set done_when to something checkable in the workspace or tool results.`;

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
  const wantsAppOrSite =
    /\b(html|css|javascript|\.js\b|canvas|bubble.?shooter|game in html|website|web app|landing page|react|vue|svelte|frontend|vanilla)\b/.test(
      msg,
    ) ||
    /\b(create|make|build|design|scaffold|implement|write)\b.{0,100}\b(game|app|website|page|project|calculator|widget|todo|todos|counter|clock|quiz|form|dashboard|ui)\b/.test(
      msg,
    ) ||
    /\b(calculator|todo\s*app|to-?do list|counter app|stopwatch|timer app|quiz app)\b/.test(
      msg,
    );
  const wantsCodeFix =
    /\b(implement|refactor|add|write)\b.{0,40}\b(auth|api|endpoint|module|component|function|class|test)\b/.test(
      msg,
    ) || /\b(python|typescript|node\.?js)\b/.test(msg);
  const wantsDebug =
    /\b(debug|fix|why.*(fail|error|broken)|stack\s*trace|reproduce)\b/.test(msg) ||
    /\b(fix|debug)\b.{0,40}\b(bug|error|crash|issue|fail)\b/.test(msg);
  const wantsOffice =
    /\b(xlsx|xls|csv|spreadsheet|excel|pptx|powerpoint|docx|word\s*doc|google\s*doc|google\s*sheet)\b/.test(
      msg,
    );
  const wantsDocOnly =
    (/\bpdf\b/.test(msg) ||
      /\b(generate|create|make|write)\b.{0,40}\b(book|report|guide|manual|essay|document|memo)\b/.test(
        msg,
      ) ||
      wantsOffice) &&
    !wantsAppOrSite &&
    !wantsCodeFix;
  const wantsResearch =
    /\b(research|investigate|look\s*up|sources?|cite)\b/.test(msg) &&
    !wantsAppOrSite &&
    !wantsDocOnly &&
    !wantsDebug;

  if (wantsDebug && !wantsAppOrSite) {
    taskType = 'debug';
  } else if (wantsAppOrSite || wantsCodeFix) {
    taskType = 'build';
  } else if (wantsDocOnly) {
    taskType = 'document';
  } else if (wantsResearch) {
    taskType = 'research';
  } else if (/^\s*(hi|hello|hey|thanks|thank you)\b/.test(msg) && msg.length < 40) {
    taskType = 'chat';
  }

  // GitHub / remote repo → build with clone + tests priority
  if (
    /github\.com|gitlab\.com|bitbucket\.org|\bgit\s+clone\b/i.test(String(userMessage || '')) ||
    /github\.com|gitlab\.com/.test(msg)
  ) {
    if (taskType === 'chat' || taskType === 'question' || taskType === 'mixed' || taskType === 'research') {
      taskType = 'build';
    }
  }

  const needsClarification = o.needs_clarification === true || o.needsClarification === true;
  const maxSteps = Math.min(
    Math.max(Number(o.max_steps || o.maxSteps || o.budget_steps) || 0, 0),
    16,
  );

  let toolsPriority = Array.isArray(o.tools_priority)
    ? o.tools_priority.map(String)
    : Array.isArray(o.toolsPriority)
      ? o.toolsPriority.map(String)
      : [];
  if (taskType === 'document') {
    if (/\b(xlsx|xls|csv|spreadsheet|excel)\b/.test(msg)) {
      toolsPriority = ['csv_write', 'create_document', 'write_file'].concat(
        toolsPriority.filter(
          (t) => ['csv_write', 'create_document', 'write_file'].indexOf(t) < 0,
        ),
      );
    } else if (/\bpdf\b/.test(msg)) {
      toolsPriority = ['create_pdf', 'create_document'].concat(
        toolsPriority.filter((t) => t !== 'create_pdf' && t !== 'create_document'),
      );
    } else if (!toolsPriority.length) {
      toolsPriority = ['create_document', 'create_pdf'];
    }
  }
  if (taskType === 'debug') {
    toolsPriority = [
      'search_code',
      'read_file',
      'execute_command',
      'run_tests',
      'patch_file',
      'write_file',
      'preview_project',
    ].concat(
      toolsPriority.filter(
        (t) =>
          [
            'search_code',
            'read_file',
            'execute_command',
            'run_tests',
            'patch_file',
            'write_file',
            'preview_project',
          ].indexOf(t) < 0,
      ),
    );
  }
  if (taskType === 'build') {
    const isRemote =
      /github\.com|gitlab\.com|bitbucket\.org|\bgit\s+clone\b/i.test(
        String(userMessage || ''),
      );
    if (isRemote) {
      toolsPriority = [
        'git_clone',
        'repo_open',
        'search_code',
        'run_tests',
        'write_file',
        'patch_file',
        'preview_project',
      ].concat(
        toolsPriority.filter(
          (t) =>
            [
              'git_clone',
              'repo_open',
              'search_code',
              'run_tests',
              'write_file',
              'patch_file',
              'preview_project',
            ].indexOf(t) < 0,
        ),
      );
    } else {
      toolsPriority = ['write_file', 'create_directory', 'list_directory', 'view_tree']
        .concat(
          toolsPriority.filter(
            (t) =>
              ['write_file', 'create_directory', 'list_directory', 'view_tree'].indexOf(t) <
              0,
          ),
        );
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
  if (taskType === 'build') {
    [
      'Do not paste Python open()/zipfile or shell heredocs as a substitute for write_file',
      'Do not dump full source only in chat — call write_file for each file under /home/user/projects/<slug>/',
      'Do not invent Download links or claim files exist without write_file tool results',
      'Do not use run_python to "save" project files — use write_file',
      'Workspace Files panel is how the user downloads — list real paths after writes',
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

  const acceptanceTests = Array.isArray(o.acceptance_tests)
    ? o.acceptance_tests.map(String)
    : Array.isArray(o.acceptanceTests)
      ? o.acceptanceTests.map(String)
      : successCriteria.slice();

  const files = Array.isArray(o.files)
    ? o.files
        .map((f) =>
          typeof f === 'string' ? f : (f && (f.path || f.name)) || '',
        )
        .map((s) => String(s || '').trim())
        .filter(Boolean)
    : Array.isArray(o.file_list)
      ? o.file_list.map(String).map((s) => s.trim()).filter(Boolean)
      : [];

  const planSteps = Array.isArray(o.plan_steps)
    ? o.plan_steps
        .map((s) =>
          typeof s === 'string' ? s : (s && (s.text || s.content)) || '',
        )
        .map((s) => String(s || '').trim())
        .filter(Boolean)
    : [];

  return {
    understanding: String(o.understanding || '').trim(),
    goal: String(o.goal || '').trim() || String(userMessage || '').slice(0, 200),
    task_type: taskType,
    success_criteria: successCriteria,
    acceptance_tests: acceptanceTests,
    done_when: doneWhen,
    approach: Array.isArray(o.approach) ? o.approach.map(String) : [],
    plan_steps: planSteps,
    files,
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
    template_id: o.template_id || o.templateId || undefined,
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
  if (b.acceptance_tests && b.acceptance_tests.length) {
    lines.push('Acceptance tests (must pass before done):');
    b.acceptance_tests.forEach((c, i) => lines.push(i + 1 + '. ' + c));
  } else if (b.success_criteria && b.success_criteria.length) {
    lines.push('', '## Success criteria (must meet before finishing)');
    b.success_criteria.forEach((c, i) => lines.push(i + 1 + '. ' + c));
  }
  if (Array.isArray(b.files) && b.files.length) {
    lines.push('', '## Files to create or edit');
    b.files.forEach((c, i) => lines.push(i + 1 + '. ' + c));
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
    '- Never dump Python open()/zipfile or paste full source only in chat — that does NOT create workspace files.',
    '- Never invent Download links. After write_file, tell the user the real paths (Files panel).',
    '- Do not narrate process. Act, then give a short useful final answer (prefix with <answer> when done).',
    '- Never invent results. If blocked, say what you need.',
  );
  return lines.join('\n');
}

function analystUserPrompt(userMessage, historySnippet) {
  let prompt =
    'Step 1 — What does this user want me to do?\n' +
    'User prompt (verbatim):\n"""\n' +
    String(userMessage || '').trim() +
    '\n"""\n\n' +
    'Step 2 — Decide task_type and whether an implementation plan is required.\n' +
    'Step 3 — Produce the JSON briefing with files[], tools_priority, done_when, acceptance_tests, and a specific executor_brief (design/structure/feel or document outline included when relevant).\n' +
    'Available capability families (pick tools_priority from these): ' +
    'workspace files (write_file, read_file, list_directory, patch_file), ' +
    'preview/verify (preview_project, verify_project, run_tests), ' +
    'documents (create_pdf, create_document, csv_write), ' +
    'web (search_web, fetch_url, navigate, read_page), ' +
    'git (git_clone, git_status, git_commit, create_pull_request), ' +
    'shell (execute_command, run_python, run_javascript).\n';
  if (historySnippet) {
    prompt +=
      '\nRecent conversation context (may help):\n' +
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
