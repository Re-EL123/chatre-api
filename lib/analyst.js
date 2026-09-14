'use strict';

/**
 * Analyst → executor briefing for Chatre.
 * The analyst understands the request and writes a task-specific brief;
 * the executor follows that brief (not a one-size-fits-all loop).
 */

const ANALYST_SYSTEM_PROMPT = `You are Chatre's analysis agent. You do NOT execute tools. Your job is to understand THIS specific user request with high precision and write a brief another Chatre executor will follow.

Reflective process (encode into JSON — no prose outside JSON):
1) Restate the concrete goal in the user's words.
2) List assumptions you are making and unknowns you still have.
3) Score confidence 0–1. If confidence < 0.75 OR unknowns remain, set needs_clarification true and ask ONE short question (prefer choices the user can answer in a few words).
4) Classify deliverable_kind: "answer" (explain only), "deliver" (workspace files/actions), or "mixed".
5) How-to / what-is / explain requests default to answer — do NOT invent an app/PDF unless the user asked for one.
6) Imperative creates (apps, games, websites, docs, PDFs, spreadsheets, code) → deliver with build or document.
7) Suggest a composer mode with a one-line reason (chat|agent|browse|explore|plan). Suggestion only — never claim you switched modes.

Rules:
- You are Chatre. Never mention other products or agents.
- No flattery. Be direct. Do not invent specs to avoid clarifying.
- Prefer asking over guessing for product shape, stack, tone, audience, or scope.
- Always set measurable done_when and acceptance_tests (never vague "goal completed").
- Always set files[] when deliverable_kind is deliver.
- tools_priority must name real tools.

Output ONLY a single JSON object (no markdown fences) with this shape:
{
  "understanding": "1-3 sentences: what the user actually wants",
  "goal": "one-line concrete goal",
  "task_type": "chat|question|research|browser|build|debug|document|git|run|mixed",
  "deliverable_kind": "answer|deliver|mixed",
  "assumptions": ["what you inferred"],
  "unknowns": ["what is still unclear — empty if confident"],
  "confidence": 0.0,
  "suggested_mode": "chat|agent|browse|explore|plan",
  "mode_reason": "one sentence why that mode fits",
  "success_criteria": ["observable checks that prove done"],
  "acceptance_tests": ["enterprise acceptance checks"],
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
  "executor_brief": "Multi-paragraph instructions TO the executor. Specific — not a generic lecture."
}

Set max_steps thoughtfully (prefer 8–12 for builds/docs). If deliverable_kind is answer, keep tools_priority empty or read-only and do not invent files[].`;

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

function normalizeBriefing(obj, userMessage, opts) {
  const Understanding = require('./understanding');
  const o = obj && typeof obj === 'object' ? obj : {};
  const options = opts || {};
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

  const msg = String(userMessage || '');
  const assumptions = Understanding.asStringList(o.assumptions);
  const unknowns = Understanding.asStringList(o.unknowns);
  const confidenceExplicit =
    o.confidence != null || o.understanding_confidence != null;
  const confidence = Understanding.clamp01(
    o.confidence != null ? o.confidence : o.understanding_confidence,
    unknowns.length ? 0.55 : 0.82,
  );

  const taskTypeRaw = String(o.task_type || o.taskType || 'mixed').toLowerCase();
  let taskType = Understanding.resolveTaskType(taskTypeRaw, msg, confidence);

  if (
    /github\.com|gitlab\.com|bitbucket\.org|\bgit\s+clone\b/i.test(msg) &&
    (taskType === 'chat' || taskType === 'question' || taskType === 'mixed')
  ) {
    taskType = 'build';
  }

  let needsClarification = o.needs_clarification === true || o.needsClarification === true;
  const maxSteps = Math.min(
    Math.max(Number(o.max_steps || o.maxSteps || o.budget_steps) || 0, 0),
    16,
  );

  let toolsPriority = Array.isArray(o.tools_priority)
    ? o.tools_priority.map(String)
    : Array.isArray(o.toolsPriority)
      ? o.toolsPriority.map(String)
      : [];

  const deliverableKind =
    String(o.deliverable_kind || o.deliverableKind || '').toLowerCase() ||
    Understanding.classifyDeliverableKind(msg, taskType);

  if (deliverableKind === 'answer') {
    toolsPriority = toolsPriority.filter((t) =>
      /^(search_|fetch_|read_|list_|view_|web_|session_)/.test(t),
    );
  }

  if (taskType === 'document' && deliverableKind !== 'answer') {
    const lower = msg.toLowerCase();
    if (/\b(xlsx|xls|csv|spreadsheet|excel)\b/.test(lower)) {
      toolsPriority = ['csv_write', 'create_document', 'write_file'].concat(
        toolsPriority.filter(
          (t) => ['csv_write', 'create_document', 'write_file'].indexOf(t) < 0,
        ),
      );
    } else if (/\bpdf\b/.test(lower)) {
      toolsPriority = ['create_pdf', 'create_document'].concat(
        toolsPriority.filter((t) => t !== 'create_pdf' && t !== 'create_document'),
      );
    } else if (!toolsPriority.length) {
      toolsPriority = ['create_document', 'create_pdf'];
    }
  }
  if (taskType === 'debug' && deliverableKind !== 'answer') {
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
  if (taskType === 'build' && deliverableKind !== 'answer') {
    const isRemote = /github\.com|gitlab\.com|bitbucket\.org|\bgit\s+clone\b/i.test(msg);
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
      toolsPriority = ['write_file', 'create_directory', 'list_directory', 'view_tree'].concat(
        toolsPriority.filter(
          (t) =>
            ['write_file', 'create_directory', 'list_directory', 'view_tree'].indexOf(t) < 0,
        ),
      );
    }
  }

  const doNot = Array.isArray(o.do_not)
    ? o.do_not.map(String)
    : Array.isArray(o.doNot)
      ? o.doNot.map(String)
      : [];
  if (taskType === 'document' && deliverableKind !== 'answer') {
    [
      'Do not invent download URLs',
      'Do not dump Python/fpdf or /mnt/data paths',
      'Do not claim a file exists without a successful create_pdf/create_document tool result',
      'Do not explore the web unless facts are missing — deliver the file',
    ].forEach((rule) => {
      if (doNot.indexOf(rule) < 0) doNot.push(rule);
    });
  }
  if (taskType === 'build' && deliverableKind !== 'answer') {
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
  let doneWhenRaw = String(o.done_when || o.doneWhen || '').trim();
  if (Understanding.isSoftDoneWhen(doneWhenRaw)) doneWhenRaw = '';
  const { deriveDoneWhen } = require('./smart-agent');
  let doneWhen =
    doneWhenRaw ||
    deriveDoneWhen(
      {
        success_criteria: successCriteria,
        task_type: taskType,
        deliverable_kind: deliverableKind,
      },
      userMessage,
      taskType,
    );
  if (Understanding.isSoftDoneWhen(doneWhen)) {
    doneWhen = '';
  }
  if (!successCriteria.length && doneWhen) successCriteria = [doneWhen];

  const acceptanceTests = Array.isArray(o.acceptance_tests)
    ? o.acceptance_tests.map(String)
    : Array.isArray(o.acceptanceTests)
      ? o.acceptanceTests.map(String)
      : successCriteria.slice();

  let files = Array.isArray(o.files)
    ? o.files
        .map((f) => (typeof f === 'string' ? f : (f && (f.path || f.name)) || ''))
        .map((s) => String(s || '').trim())
        .filter(Boolean)
    : Array.isArray(o.file_list)
      ? o.file_list.map(String).map((s) => s.trim()).filter(Boolean)
      : [];
  if (deliverableKind === 'answer') files = [];

  const planSteps = Array.isArray(o.plan_steps)
    ? o.plan_steps
        .map((s) => (typeof s === 'string' ? s : (s && (s.text || s.content)) || ''))
        .map((s) => String(s || '').trim())
        .filter(Boolean)
    : [];

  Understanding.answerFirstDoNot({ deliverable_kind: deliverableKind }).forEach((rule) => {
    if (doNot.indexOf(rule) < 0) doNot.push(rule);
  });

  let briefing = {
    understanding: String(o.understanding || '').trim(),
    goal: String(o.goal || '').trim() || String(userMessage || '').slice(0, 200),
    task_type: taskType,
    deliverable_kind: deliverableKind,
    assumptions,
    unknowns,
    confidence,
    suggested_mode: String(o.suggested_mode || o.suggestedMode || '').toLowerCase() || undefined,
    mode_reason: String(o.mode_reason || o.modeReason || '').trim() || undefined,
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
    user_corrections: Understanding.asStringList(o.user_corrections || o.userCorrections),
    intent_contract: '',
  };

  if (options.corrections && options.corrections.length) {
    briefing = Understanding.mergeCorrections(briefing, options.corrections);
  } else if (briefing.user_corrections.length) {
    briefing = Understanding.mergeCorrections(briefing, briefing.user_corrections);
  }

  const modeInfo = Understanding.suggestMode(briefing, options.composerMode);
  if (!briefing.suggested_mode) briefing.suggested_mode = modeInfo.suggested_mode;
  if (!briefing.mode_reason) briefing.mode_reason = modeInfo.mode_reason;
  briefing.mode_suggestion = modeInfo;

  briefing._confidenceExplicit = confidenceExplicit;
  briefing = Understanding.applyUnderstandingGate(briefing, userMessage, {
    skipGate: options.skipGate || options.approvePlan === true,
    confidenceExplicit,
  });
  delete briefing._confidenceExplicit;
  briefing.intent_contract = Understanding.formatIntentContract(briefing);
  return briefing;
}

/**
 * Build the message the executor receives — the analyst's custom prompt.
 */
function formatExecutorPrompt(briefing, userMessage) {
  const Understanding = require('./understanding');
  const b = briefing || {};
  const lines = [
    '# Executor orders (from Chatre analysis — follow these, not a generic script)',
    '',
    '## Intent contract (authoritative)',
    b.intent_contract || Understanding.formatIntentContract(b),
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
    '## Task type / deliverable',
    (b.task_type || 'mixed') + ' · ' + (b.deliverable_kind || 'mixed'),
    'Confidence: ' +
      (b.confidence != null ? Math.round(Number(b.confidence) * 100) + '%' : 'n/a'),
  ];

  if (b.assumptions && b.assumptions.length) {
    lines.push('', '## Assumptions');
    b.assumptions.forEach((c) => lines.push('- ' + c));
  }
  if (b.unknowns && b.unknowns.length) {
    lines.push('', '## Unknowns (should have been clarified — do not invent)');
    b.unknowns.forEach((c) => lines.push('- ' + c));
  }
  if (b.user_corrections && b.user_corrections.length) {
    lines.push('', '## User corrections (must obey)');
    b.user_corrections.forEach((c) => lines.push('- ' + c));
  }
  if (b.suggested_mode) {
    lines.push(
      '',
      '## Suggested mode (soft — user may stay in ' +
        ((b.mode_suggestion && b.mode_suggestion.current_mode) || 'current') +
        ')',
      b.suggested_mode + (b.mode_reason ? ' — ' + b.mode_reason : ''),
    );
  }

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
    lines.push('', '## Preferred tools (in order)', b.tools_priority.join(', '));
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
  if (b.deliverable_kind === 'answer') {
    lines.push(
      '',
      '## Answer-first mode',
      '- Explain clearly. Do not scaffold projects or write files unless the user explicitly asks.',
    );
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

function analystUserPrompt(userMessage, historySnippet, extras) {
  const ex = extras || {};
  let prompt =
    'Step 1 — What does this user want? Restate goal, list assumptions + unknowns, score confidence.\n' +
    'User prompt (verbatim):\n"""\n' +
    String(userMessage || '').trim() +
    '\n"""\n\n' +
    'Step 2 — Set deliverable_kind (answer|deliver|mixed) and task_type. How-to/explain → answer unless they asked for a file/app.\n' +
    'Step 3 — If confidence < 0.75 or unknowns remain, needs_clarification=true with ONE short clarification_question.\n' +
    'Step 4 — Produce the JSON briefing with measurable done_when (not vague), acceptance_tests, suggested_mode + mode_reason, and a specific executor_brief.\n' +
    'Available capability families (pick tools_priority from these): ' +
    'workspace files (write_file, read_file, list_directory, patch_file), ' +
    'preview/verify (preview_project, verify_project, run_tests), ' +
    'documents (create_pdf, create_document, csv_write), ' +
    'web (search_web, fetch_url, navigate, read_page), ' +
    'git (git_clone, git_status, git_commit, create_pull_request), ' +
    'shell (execute_command, run_python, run_javascript).\n';
  if (ex.corrections && ex.corrections.length) {
    prompt +=
      '\nUser corrections from this thread (must respect):\n- ' +
      ex.corrections.map(String).slice(0, 8).join('\n- ') +
      '\n';
  }
  if (ex.composerMode) {
    prompt +=
      '\nCurrent composer mode (soft preference, do not hallucinate a switch): ' +
      String(ex.composerMode) +
      '\n';
  }
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
