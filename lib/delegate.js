'use strict';

/**
 * Structured subagent delegation — explore / general / verify / build slices.
 */

const Agents = require('./agents');
const Blackboard = require('./blackboard');
const { TOOL_DEFS } = require('./tool-defs');

const STRUCTURED_RETURN = `When finished, end with a JSON block tagged answer_json (or plain JSON) containing:
{
  "summary": "1-3 sentences",
  "findings": ["…"],
  "filesChanged": ["/home/user/..."],
  "risks": ["…"],
  "nextActions": ["…"],
  "todos": [{"id":"t1","content":"…","owner":"build|verify|explore","status":"pending|done"}]
}
Prefer tools over narration. Complete ONLY the assigned goal.`;

function toolAllowlist(agentName) {
  const n = String(agentName || 'general').toLowerCase();
  if (n === 'explore') {
    return /^(read_file|list_directory|view_tree|find_files|search_code|search_web|fetch_url|http_request|web_extract)$/;
  }
  if (n === 'verify') {
    return /^(read_file|list_directory|view_tree|find_files|search_code|preview_project|verify_project|execute_command|run_javascript|run_python|execute_code)$/;
  }
  if (n === 'general' || n === 'build') {
    return /^(write_file|append_file|read_file|list_directory|view_tree|find_files|search_code|create_directory|patch_file|apply_patch|execute_code|run_javascript|run_python|execute_command|create_document|create_pdf|preview_project|verify_project|todo|todo_write)$/;
  }
  // custom: generous but no nested delegate
  return /^(write_file|append_file|read_file|list_directory|view_tree|find_files|search_code|create_directory|patch_file|apply_patch|execute_code|run_javascript|run_python|execute_command|create_document|create_pdf|preview_project|verify_project|search_web|fetch_url|http_request)$/;
}

function maxStepsFor(agentName, requested, thoroughness) {
  const n = String(agentName || 'general').toLowerCase();
  let cap = 6;
  if (n === 'explore') {
    const t = String(thoroughness || 'medium').toLowerCase();
    if (t === 'quick' || t === 'fast') cap = 3;
    else if (t === 'very thorough' || t === 'thorough' || t === 'deep') cap = 8;
    else cap = 5;
  } else if (n === 'verify') {
    cap = 5;
  } else if (n === 'general' || n === 'build') {
    cap = 7;
  }
  const req = Number(requested) || (n === 'explore' ? 4 : 5);
  return Math.min(Math.max(1, req), cap);
}

function parseStructuredAnswer(text) {
  const raw = String(text || '');
  const fence = raw.match(/```(?:answer_json|json)\s*([\s\S]*?)```/i);
  let obj = null;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  if (fence) obj = tryParse(fence[1].trim());
  if (!obj) {
    const start = raw.lastIndexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) obj = tryParse(raw.slice(start, end + 1));
  }
  if (!obj || typeof obj !== 'object') {
    return {
      summary: raw.replace(/```[\s\S]*?```/g, '').trim().slice(0, 2000) || 'Sub-agent finished',
      findings: [],
      filesChanged: [],
      risks: [],
      nextActions: [],
      todos: [],
    };
  }
  return {
    summary: String(obj.summary || obj.text || '').slice(0, 2000) || 'Sub-agent finished',
    findings: Array.isArray(obj.findings) ? obj.findings.map(String).slice(0, 30) : [],
    filesChanged: Array.isArray(obj.filesChanged || obj.files)
      ? (obj.filesChanged || obj.files).map(String).slice(0, 40)
      : [],
    risks: Array.isArray(obj.risks) ? obj.risks.map(String).slice(0, 20) : [],
    nextActions: Array.isArray(obj.nextActions || obj.next)
      ? (obj.nextActions || obj.next).map(String).slice(0, 20)
      : [],
    todos: Array.isArray(obj.todos) ? obj.todos.slice(0, 20) : [],
  };
}

function filterTools(agentName) {
  const re = toolAllowlist(agentName);
  return TOOL_DEFS.filter((t) => {
    const name = t.function && t.function.name;
    return name && re.test(name);
  });
}

/**
 * @param {object} opts
 * @param {function} opts.chatWorkerWithTools
 * @param {function} opts.parseToolCalls
 * @param {function} opts.cleanText
 * @param {function} opts.executeRemoteTool
 * @param {function} opts.applySpillToResult
 * @param {function} opts.shrinkToolResult
 * @param {function} opts.workspaceInventory
 */
async function runDelegate(opts) {
  const {
    goal,
    context,
    agentName,
    thoroughness,
    maxSteps,
    model,
    userId,
    parentCtx,
    chatWorkerWithTools,
    parseToolCalls,
    cleanText,
    executeRemoteTool,
    applySpillToResult,
    shrinkToolResult,
    workspaceInventory,
  } = opts;

  const childName = String(agentName || 'general').toLowerCase();
  const childAgent =
    Agents.getNative(childName) ||
    Agents.resolveAgent({
      agentName: childName,
      taskType: 'mixed',
      customAgents: (parentCtx && parentCtx.customAgents) || [],
    });
  const resolvedName = (childAgent && childAgent.name) || childName;
  const childRules = Agents.deriveSubagentSessionPermission(
    (parentCtx && parentCtx.permissionRuleset) || [],
    (childAgent && childAgent.permission) || [],
  );
  const childCtx = Object.assign({}, parentCtx, {
    agentInfo: childAgent,
    permissionRuleset: childRules,
    approvedTools: new Set(
      (parentCtx && parentCtx.approvedTools) || [],
    ),
  });
  // Verify may need preview without ask friction in delegated context
  if (resolvedName === 'verify' && childCtx.approvedTools) {
    childCtx.approvedTools.add('preview_project');
    childCtx.approvedTools.add('verify_project');
    childCtx.approvedTools.add('execute_command');
  }

  const bbText = Blackboard.formatForPrompt(
    (parentCtx && parentCtx.blackboard) || null,
    1800,
  );
  const steps = maxStepsFor(resolvedName, maxSteps, thoroughness);
  const msgs = [
    {
      role: 'user',
      content:
        'You are a Chatre sub-agent (**' +
        resolvedName +
        '**).\n' +
        Agents.agentSystemExtra(childAgent, { thoroughness }) +
        '\n\nGoal:\n' +
        goal +
        (context ? '\n\nContext:\n' + context : '') +
        '\n\n' +
        bbText +
        '\n\nWorkspace inventory:\n' +
        workspaceInventory(parentCtx.files, { limit: 24 }).text +
        '\n\n' +
        STRUCTURED_RETURN,
    },
  ];

  let last = '';
  let toolsUsed = 0;
  const filesChanged = [];
  const tools = filterTools(resolvedName);

  for (let s = 0; s < steps; s++) {
    let stepText = '';
    let structuredCalls = [];
    try {
      const structured = await chatWorkerWithTools({
        messages: msgs,
        model: model || (parentCtx && parentCtx.model),
        userId,
        maxTokens: resolvedName === 'explore' ? 1000 : 1400,
        agent: true,
        tools,
        onToken: (d) => {
          stepText += d;
        },
      });
      stepText = structured.text || stepText;
      structuredCalls = structured.toolCalls || [];
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        summary: last,
        findings: [],
        filesChanged,
        risks: [],
        nextActions: [],
        todos: [],
        toolsUsed,
        steps: s + 1,
        agent: resolvedName,
        text: last,
      };
    }

    const calls = parseToolCalls(stepText, structuredCalls);
    last = cleanText(stepText) || last;
    if (!calls.length) break;

    msgs.push({ role: 'assistant', content: stepText });
    const results = [];
    for (const call of calls.slice(0, 4)) {
      const result = await applySpillToResult(
        await executeRemoteTool(call, childCtx),
        childCtx,
        call.tool,
      );
      toolsUsed += 1;
      if (result && result.path) filesChanged.push(result.path);
      if (result && Array.isArray(result.results)) {
        result.results.forEach((r) => {
          if (r && r.path) filesChanged.push(r.path);
        });
      }
      results.push({
        tool: call.tool,
        result: shrinkToolResult(result, 600),
      });
    }
    msgs.push({
      role: 'user',
      content:
        'Tool results:\n' +
        JSON.stringify(results) +
        '\n\nContinue, or finish with the structured JSON answer if the goal is done.',
    });
  }

  const structured = parseStructuredAnswer(last);
  if (!structured.filesChanged.length && filesChanged.length) {
    structured.filesChanged = Array.from(new Set(filesChanged));
  }
  // Sync child file mutations already on shared ctx.files
  if (parentCtx && parentCtx.blackboard) {
    Blackboard.mergeDelegateResult(parentCtx.blackboard, {
      agent: resolvedName,
      ok: true,
      summary: structured.summary,
      findings: structured.findings,
      filesChanged: structured.filesChanged,
      risks: structured.risks,
      nextActions: structured.nextActions,
      todos: structured.todos,
    });
    Blackboard.applyToCtx(parentCtx.blackboard, parentCtx);
  }

  return {
    ok: true,
    summary: structured.summary,
    findings: structured.findings,
    filesChanged: structured.filesChanged,
    risks: structured.risks,
    nextActions: structured.nextActions,
    todos: structured.todos,
    toolsUsed,
    steps,
    agent: resolvedName,
    text: structured.summary,
    contract: structured,
  };
}

/**
 * Parallel fan-out for independent goals (explore-safe by default).
 * goals: [{ goal, agent?, context?, thoroughness? }, ...]
 */
async function runParallelDelegates(opts) {
  const goals = Array.isArray(opts.goals) ? opts.goals : [];
  if (!goals.length) {
    return { ok: false, error: 'goals[] required', results: [] };
  }
  const capped = goals.slice(0, 4);
  const results = await Promise.all(
    capped.map((g) =>
      runDelegate(
        Object.assign({}, opts, {
          goal: String((g && (g.goal || g.task)) || '').trim(),
          context: (g && g.context) || opts.context,
          agentName: (g && (g.agent || g.subagent)) || 'explore',
          thoroughness: (g && g.thoroughness) || opts.thoroughness,
          maxSteps: (g && g.max_steps) || opts.maxSteps,
        }),
      ),
    ),
  );
  const summary = results
    .map((r, i) => {
      const g = capped[i];
      return (
        '### ' +
        ((g && g.agent) || r.agent || 'agent') +
        ': ' +
        String((g && g.goal) || '').slice(0, 80) +
        '\n' +
        (r.summary || r.error || '')
      );
    })
    .join('\n\n');
  const merged = {
    ok: results.every((r) => r && r.ok !== false),
    summary,
    findings: [],
    filesChanged: [],
    risks: [],
    nextActions: [],
    todos: [],
    results,
    parallel: true,
    text: summary,
    agent: 'parallel',
    toolsUsed: results.reduce((n, r) => n + (r.toolsUsed || 0), 0),
  };
  results.forEach((r) => {
    if (!r) return;
    merged.findings = merged.findings.concat(r.findings || []);
    merged.filesChanged = merged.filesChanged.concat(r.filesChanged || []);
    merged.risks = merged.risks.concat(r.risks || []);
    merged.nextActions = merged.nextActions.concat(r.nextActions || []);
    merged.todos = merged.todos.concat(r.todos || []);
  });
  return merged;
}

module.exports = {
  STRUCTURED_RETURN,
  toolAllowlist,
  maxStepsFor,
  parseStructuredAnswer,
  filterTools,
  runDelegate,
  runParallelDelegates,
};
