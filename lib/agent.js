'use strict';

const {
  chatWorker,
  chatWorkerStreaming,
  chatWorkerWithTools,
  estimateTokens,
  affordableTokensFromError,
  isCreditError,
  parseModel,
} = require('./llm');
const ContextRag = require('./context-rag');
const VerifyLoop = require('./verify-loop');
const ContextCache = require('./context-cache');
const { TOOL_DEFS, normalizeToolCall } = require('./tool-defs');
const { listFiles, getWorkspace, saveSnapshot, putFile, deleteFile, deleteFileTree, bumpRevision } = require('./workspace');
const Sync = require('./workspace-sync');
const { runInTempWorkspace, runWorkspaceCommand, resolveMode } = require('./shell');
const { runInVercelSandbox } = require('./sandbox');
const shellSessions = require('./shell-session');
const {
  appendMessage,
  recordUsage,
  saveAgentRun,
  getThread,
  updateThread,
  appendUnderstandingOutcome,
  mergeDurableCorrections,
} = require('./threads');
const UnderstandingLog = require('./understanding-log');
const {
  detectSkills,
  SKILL_GUIDES,
  composeActiveSkills,
  DESIGN_DOC_HINT,
  designTemplateBlock,
  expandSkillGuide,
  skillCatalogBrief,
} = require('./skills');
const SelfAwareness = require('./self-awareness');
const ProjectRules = require('./project-rules');
const FileOutline = require('./file-outline');
const {
  TOKEN_BUDGETS,
  deriveDoneWhen,
  workspaceInventory,
  isSuccessfulTool,
  isDeliverySuccess,
  isProgressSuccess,
  artifactLooksDone,
  checkEarlyStop,
  shrinkToolResult,
  buildRunDiagnostics,
  smartMaxSteps,
  workspacePlaybookExtra,
  shouldDocumentFastPath,
} = require('./smart-agent');
const {
  shouldBuildFastPath,
  projectSlug,
  resolveProjectTarget,
  isMinimalPageRequest,
  constrainFilesToRequest,
  extractFilesFromNarration,
  looksLikeFakeDeliveryClaim,
  buildFilesPrompt,
  parseGeneratedFiles,
  unescapeFileContent,
  unwrapFilesJsonBlob,
  scaffoldHtmlProject,
} = require('./build-delivery');
const {
  ensureProject,
  noteProjectWrite,
  projectContextBlock,
  detectProjects,
  slugFromPath,
  isUnderProjects,
} = require('./projects');
const { runPreviewProject } = require('./preview');
const RepoMode = require('./repo-mode');
const GithubPr = require('./github-pr');
const OrgPolicy = require('./org-policy');
const { newId } = require('./http');
const {
  resolveWorkspacePath,
  ensureParentDirs,
  toolParamsLookValid,
  validateToolCall,
  pathMissResult,
} = require('./paths');
const { spillIfNeeded } = require('./tool-truncate');
const {
  applyTodoAction,
  recordToolPhase,
  finishGate,
  emptyTodos,
  CHATRE_AGENT_PROMPT,
} = require('./workflow');
const { runBrowserTool } = require('./browser-client');
const { runDesktopTool, isDesktopTool } = require('./desktop-client');
const { httpRequest } = require('./computer');
const { fetchUrl } = require('./fetch-readable');
const { downloadFile } = require('./download-file');
const { patchFileContent } = require('./patch-file');
const { applyV4aPatchText } = require('./v4a-patch');
const { processManage } = require('./process-registry');
const {
  clarifyTool,
  executeCodeTool,
  webExtractTool,
  sessionSearchTool,
  skillViewTool,
  skillManageTool,
  visionAnalyzeTool,
  imageGenerateTool,
  textToSpeechTool,
  videoAnalyzeTool,
  delegateTaskTool,
} = require('./extra-tools');
const { csvRead, csvWrite, csvQuery } = require('./csv-tools');
const userMemory = require('./user-memory');
const users = require('./users');
const { testByokProvider } = require('./byok-test');
const {
  extractJsonObject,
  normalizeBriefing,
  formatExecutorPrompt,
  analystUserPrompt,
  historySnippet,
  ANALYST_SYSTEM_PROMPT,
} = require('./analyst');
const Understanding = require('./understanding');
const { assertToolAllowed } = require('./allowlists');
const { subagentPrompt, taskTypeBiasFor } = require('./subagents');
const {
  normalizeAutonomy,
  shouldAwaitPlan,
  toolNeedsApproval,
  toolRisk,
  shouldAutoResume,
  buildRunMemoryPack,
  playbookForTaskType,
  MAX_AUTO_RESUMES,
  AUTO_RESUME_EXTRA_MS,
  AUTO_RESUME_EXTRA_STEPS,
} = require('./autonomy');
const Permission = require('./permissions');
const Agents = require('./agents');
const Blackboard = require('./blackboard');
const PlanArtifact = require('./plan-artifact');
const Delegate = require('./delegate');
const {
  generateThreadTitle,
  compactMessages,
  summarizeRun,
  generateCustomAgent,
  shouldCompact,
} = require('./agent-helpers');
const TeamPipeline = require('./team-pipeline');
const { enrichBriefing } = require('./plan-templates');
const {
  CRITIC_PROMPT,
  extractJsonObject: extractCritiqueJson,
  normalizeCritique,
  criticUserPrompt,
  verifyRoleCritique,
  mergeCritiques,
} = require('./critic');
const { createRunLog, logEvent, summarizeLog, exportAudit } = require('./run-log');
const { budgetsForTaskType } = require('./budgets');
const Delivery = require('./delivery-contract');
const ModelRouting = require('./model-routing');
const { redactValue, safeEmit } = require('./secrets-redact');

const TOOL_RESULT_SOFT_LIMIT = 900;
const CONTEXT_SOFT_LIMIT = 3200;
/** Soft wall-clock budget before Hobby/serverless cutoffs; leave headroom to save checkpoint */
const DEFAULT_BUDGET_MS = Number(process.env.CHATRE_AGENT_BUDGET_MS || 50000);

function toolCallDedupeKey(call) {
  if (!call || !call.tool) return '';
  try {
    return call.tool + '::' + JSON.stringify(call.params || {});
  } catch {
    return call.tool + '::';
  }
}

function pushNormalizedTool(item, results, seen) {
  const n = normalizeToolCall(item);
  if (!n) return;
  const key = toolCallDedupeKey(n);
  if (key && seen.has(key)) return;
  if (key) seen.add(key);
  results.push(n);
}

function ingestParsedToolJson(parsed, results, seen) {
  if (Array.isArray(parsed)) {
    parsed.forEach((item) => pushNormalizedTool(item, results, seen));
  } else if (parsed && Array.isArray(parsed.tool_calls)) {
    parsed.tool_calls.forEach((item) => pushNormalizedTool(item, results, seen));
  } else {
    pushNormalizedTool(parsed, results, seen);
  }
}

function extractBalancedToolJson(text, results, seen) {
  const raw = String(text || '');
  const needles = [
    '{"tool"',
    '{ "tool"',
    '{"type":"function"',
    '{ "type": "function"',
    '{"name"',
    '{ "name"',
  ];
  let i = 0;
  while (i < raw.length) {
    let at = -1;
    for (let n = 0; n < needles.length; n++) {
      const idx = raw.indexOf(needles[n], i);
      if (idx >= 0 && (at < 0 || idx < at)) at = idx;
    }
    if (at < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = at; j < raw.length; j++) {
      const ch = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end > at) {
      try {
        ingestParsedToolJson(JSON.parse(raw.slice(at, end + 1)), results, seen);
      } catch {
        /* ignore */
      }
      i = end + 1;
    } else {
      i = at + 1;
    }
  }
}

function tryParseToolBlock(jsonText, results, seen) {
  try {
    ingestParsedToolJson(JSON.parse(String(jsonText || '').trim()), results, seen);
  } catch {
    extractBalancedToolJson(jsonText, results, seen);
  }
}

function parseMarkdownToolCalls(text) {
  const results = [];
  const seen = new Set();
  const raw = String(text || '');
  const blockRe = /```(?:tool|tool_call|agent|json)\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = blockRe.exec(raw)) !== null) {
    tryParseToolBlock(m[1], results, seen);
  }

  // Salvage trailing unclosed ```tool / ```json fences (models often omit the closer)
  const openRe = /```(?:tool|tool_call|agent|json)\b/gi;
  let om;
  while ((om = openRe.exec(raw)) !== null) {
    const after = raw.slice(om.index);
    if (/^```(?:tool|tool_call|agent|json)\s*\n?[\s\S]*?```/i.test(after)) {
      continue;
    }
    const open = /^```(?:tool|tool_call|agent|json)\s*\n?([\s\S]*)$/i.exec(after);
    if (open) tryParseToolBlock(open[1], results, seen);
  }

  // Brace-balanced recovery for bare tool JSON (BYOK models often skip fences)
  extractBalancedToolJson(raw, results, seen);
  return results;
}

function parseToolCalls(text, structuredCalls) {
  const fromNative = (structuredCalls || [])
    .map(normalizeToolCall)
    .filter(Boolean);
  const fromMarkdown = parseMarkdownToolCalls(text);
  const validNative = fromNative.filter(
    (c) => !c.parseFailed && toolParamsLookValid(c),
  );
  const invalidNative = fromNative.filter(
    (c) => c.parseFailed || !toolParamsLookValid(c),
  );
  const validMd = fromMarkdown.filter(
    (c) => !c.parseFailed && toolParamsLookValid(c),
  );

  const out = [];
  const seen = new Set();
  const add = (c) => {
    if (!c) return;
    const key = toolCallDedupeKey(c);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(c);
  };

  // Merge native + markdown (prefer valid; markdown can salvage truncated native args)
  validNative.forEach(add);
  validMd.forEach(add);
  const mdTools = new Set(validMd.map((c) => c.tool));
  invalidNative.forEach((c) => {
    if (mdTools.has(c.tool)) return;
    add(c);
  });
  if (!out.length) fromMarkdown.forEach(add);
  if (!out.length) fromNative.forEach(add);
  return out;
}

async function applySpillToResult(result, ctx, tool) {
  if (!result || typeof result !== 'object') return result;
  const fields = ['output', 'content', 'text', 'stdout', 'stderr'];
  let spillPath = result.spill_path || null;
  for (let i = 0; i < fields.length; i++) {
    const k = fields[i];
    if (typeof result[k] !== 'string' || !result[k]) continue;
    const spilled = await spillIfNeeded(
      result[k],
      {
        files: ctx.files,
        filesTouched: ctx.filesTouched,
        workspaceId: ctx.workspaceId,
        putFile,
      },
      { tool: tool || result.tool || 'tool' },
    );
    if (spilled.truncated) {
      result[k] = spilled.text;
      result.truncated = true;
      result.omitted = (result.omitted || 0) + (spilled.omitted || 0);
      if (spilled.spill_path) {
        spillPath = spilled.spill_path;
        result.spill_path = spillPath;
      }
    }
  }
  return result;
}

function cleanText(text) {
  return String(text || '')
    .replace(/```(?:tool|tool_call|agent|json)\s*\n?[\s\S]*?```/g, '')
    // Strip leaked bare tool / OpenAI-function JSON the model dumps into chat
    .replace(
      /\{\s*"(?:tool|type|name)"\s*:\s*"(?:function|[a-zA-Z0-9_]+)"[\s\S]*?\}\s*/g,
      '',
    )
    .replace(/^\s*<answer>\s*/im, '')
    .replace(/<\/answer>/gi, '')
    .replace(/<confirmation\b[^>]*\/?>/gi, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (/^Continue:\s*/i.test(t)) return false;
      if (/^\[internal\]/i.test(t)) return false;
      if (/^Continue with tools/i.test(t)) return false;
      if (/^Structured tools unavailable/i.test(t)) return false;
      if (/^Resume error:/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function summarizeValue(value, budget) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length <= budget) return value;
    return (
      value.slice(0, budget) +
      '\n…[truncated ' +
      value.length +
      ' chars ~' +
      estimateTokens(value) +
      ' tokens]'
    );
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    if (json.length <= budget) return value;
    return {
      _summary: true,
      keys: Object.keys(value),
      preview: json.slice(0, budget) + '…',
      originalChars: json.length,
    };
  }
  return value;
}

function summarizeToolResults(results) {
  return results.map((row) => {
    const result = row.result || {};
    const copy = { ...result };
    if (copy.output) copy.output = summarizeValue(copy.output, TOOL_RESULT_SOFT_LIMIT);
    if (copy.content) copy.content = summarizeValue(copy.content, TOOL_RESULT_SOFT_LIMIT);
    if (copy.guide) copy.guide = summarizeValue(copy.guide, 1200);
    if (copy.text) copy.text = summarizeValue(String(copy.text), 1200);
    if (copy.html) copy.html = summarizeValue(String(copy.html), 2000);
    if (copy.screenshot_base64) {
      copy.screenshot = {
        note: 'omitted',
        bytesApprox: Math.floor((String(copy.screenshot_base64).length * 3) / 4),
      };
      delete copy.screenshot_base64;
    }
    if (copy.screenshot_preview) delete copy.screenshot_preview;
    if (copy.screenshot_ui) delete copy.screenshot_ui;
    if (copy.cookies) {
      copy.cookies = Array.isArray(copy.cookies)
        ? copy.cookies.length + ' cookies retained'
        : undefined;
    }
    return {
      tool: row.tool,
      params: summarizeParams(row.params),
      result: copy,
    };
  });
}

function summarizeParams(params) {
  if (!params || typeof params !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && v.length > 400) {
      out[k] = v.slice(0, 400) + '…[' + v.length + ' chars]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function trimMessages(messages) {
  let total = 0;
  const kept = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content || '');
    const t = estimateTokens(content) + 4;
    if (total + t > CONTEXT_SOFT_LIMIT && kept.length > 3) break;
    total += t;
    kept.unshift(msg);
  }
  if (kept.length < messages.length) {
    kept.unshift({
      role: 'user',
      content:
        '[Context compressed: earlier tool transcripts were summarized/truncated to fit the window. Continue from the latest files and goals.]',
    });
  }
  return kept;
}

function checkpointMessages(messages) {
  // Cap stored checkpoint size; keep tool_calls / tool_call_id for BYOK resume
  return trimMessages(messages).map((m) => {
    const out = {
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content.slice(0, 12000)
          : m.content == null
            ? m.content
            : JSON.stringify(m.content).slice(0, 12000),
    };
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls;
    }
    return out;
  });
}

function isSteerNoise(content) {
  const t = String(content || '').trim();
  if (!t) return false;
  return (
    /^\[internal\]/i.test(t) ||
    /^Continue:\s*/i.test(t) ||
    /^Continue with tools/i.test(t) ||
    /^Critic found gaps:/i.test(t)
  );
}

/** Drop legacy finish-gate / internal steers from thread history so the model stops mimicking them. */
function scrubSteerNoise(messages) {
  return (messages || []).filter((m) => !isSteerNoise(m && m.content));
}

async function runCommand(ctx, cmd, cwd, opts) {
  const options = opts || {};
  const mode = resolveMode(options.mode || ctx.shellMode || (ctx.briefing && ctx.briefing.shell_mode));
  const startedEmit = ctx.emit;
  const ac = new AbortController();
  ctx.shellAbort = ac;

  const onChunk = (ev) => {
    if (typeof startedEmit === 'function') {
      startedEmit({
        type: 'shell_chunk',
        stream: ev.stream,
        chunk: ev.chunk,
        needs_input: !!ev.needsInput,
        command: cmd,
        cwd: cwd || ctx.cwd,
        mode,
      });
    }
  };

  if (mode === 'local') {
    const result = await runDesktopTool(
      'desktop_exec',
      {
        cmd: cmd,
        cwd: cwd || ctx.cwd,
        timeoutMs: options.timeoutMs || 60000,
        approved: !!(options.approved || ctx.shellApproved),
      },
      ctx,
    );
    return {
      ok: !!result.ok,
      code: result.code,
      output: result.output || result.text || '',
      error: result.error,
      durationMs: result.durationMs,
      mode: 'local',
      needs_input: !!result.needs_input,
      files: ctx.files,
      cwd: cwd || ctx.cwd,
    };
  }

  if (mode === 'sandbox' || process.env.USE_VERCEL_SANDBOX === '1') {
    try {
      const sand = await runInVercelSandbox({
        files: ctx.files,
        cwd: cwd || ctx.cwd,
        command: cmd,
        timeoutMs: options.timeoutMs || 90000,
      });
      if (sand && !sand.skipped) {
        if (sand.files) {
          const before = ctx.files;
          ctx.files = Sync.mergeCollectedFiles(before, sand.files);
          ctx.cwd = sand.cwd || ctx.cwd;
          await persistWorkspace(ctx, {
            files: ctx.files,
            prune: true,
            baseFiles: before,
          });
        }
        if (typeof startedEmit === 'function' && sand.output) {
          startedEmit({
            type: 'shell_chunk',
            stream: 'stdout',
            chunk: sand.output,
            command: cmd,
            mode: 'sandbox',
          });
        }
        return { ...sand, mode: 'sandbox', durationMs: sand.durationMs || null };
      }
    } catch (e) {
      console.warn('Vercel Sandbox failed, using workspace:', e.message || e);
    }
  }

  const result = await runWorkspaceCommand({
    files: ctx.files,
    cwd: cwd || ctx.cwd,
    command: cmd,
    timeoutMs: options.timeoutMs || 25000,
    workspaceId: ctx.workspaceId,
    onChunk,
    signal: ac.signal,
    network: options.network,
    pack: options.pack,
  });
  const beforeCollect = ctx.files;
  ctx.files = Sync.mergeCollectedFiles(beforeCollect, result.files || {});
  ctx.cwd = result.cwd || ctx.cwd;
  await persistWorkspace(ctx, {
    files: ctx.files,
    prune: true,
    baseFiles: beforeCollect,
  });
  return result;
}

function attachProjectRules(ctx, filePath, out) {
  if (!ctx || !filePath || !out || !out.ok) return out;
  if (!ctx._rulesAttached) ctx._rulesAttached = new Set();
  const rules = ProjectRules.matchingRules(ctx.files, filePath).filter(
    function (r) {
      return !ctx._rulesAttached.has(r.path);
    },
  );
  if (!rules.length) return out;
  rules.forEach(function (r) {
    ctx._rulesAttached.add(r.path);
  });
  const reminder = ProjectRules.formatRulesReminder(rules);
  out.project_rules = (out.project_rules || []).concat(
    rules.map(function (r) {
      return r.path;
    }),
  );
  out.system_reminder = ((out.system_reminder || '') + '\n' + reminder).trim();
  if (out.text) out.text = String(out.text) + '\n' + reminder;
  return out;
}

async function executeRemoteTool(call, ctx) {
  const { workspaceId } = ctx;
  const tool = call.tool;
  const p = call.params || {};

  const invalid = validateToolCall(call);
  if (!invalid.ok) {
    return {
      ok: false,
      tool: tool || 'invalid',
      invalid: true,
      error: invalid.error + (invalid.hint ? ' — ' + invalid.hint : ''),
      hint: invalid.hint || null,
    };
  }

  const gate = assertToolAllowed(
    tool,
    ctx.taskType,
    ctx.briefing && ctx.briefing.tools_priority,
  );
  if (!gate.ok) {
    return { ok: false, tool, error: gate.error };
  }

  const orgCheck = OrgPolicy.checkToolPolicy(
    tool,
    ctx.orgPolicy || OrgPolicy.loadOrgPolicy(),
  );
  if (!orgCheck.ok) {
    return { ok: false, tool, error: orgCheck.error, orgPolicy: true };
  }
  if (
    orgCheck.ask &&
    !(ctx.approvedTools && (ctx.approvedTools.has(tool) || ctx.approvedTools.has('*')))
  ) {
    return {
      ok: false,
      tool,
      error: 'Org policy requires approval for ' + tool,
      needs_approval: true,
      risk: 'always',
      orgPolicy: true,
    };
  }

  // Named-agent permission ruleset (allow / ask / deny + path/.env)
  const projectRoot =
    ctx.activeProject
      ? '/home/user/projects/' + ctx.activeProject
      : ctx.cwd || '/home/user';
  const perm = Permission.evaluate(
    tool,
    p,
    ctx.permissionRuleset || Permission.defaultRuleset(),
    { projectRoot },
  );
  if (perm.action === 'deny') {
    return {
      ok: false,
      tool,
      error: 'Permission denied by agent "' +
        ((ctx.agentInfo && ctx.agentInfo.name) || 'build') +
        '": ' +
        perm.reason,
      permission: perm,
    };
  }
  if (perm.action === 'ask') {
    if (
      toolNeedsApproval(ctx.autonomy, tool, ctx.approvedTools) ||
      !(ctx.approvedTools && (ctx.approvedTools.has(tool) || ctx.approvedTools.has('session') || ctx.approvedTools.has('*')))
    ) {
      // Always pause on explicit ask from ruleset unless tool already approved
      if (!(ctx.approvedTools && (ctx.approvedTools.has(tool) || ctx.approvedTools.has('*')))) {
        return {
          ok: false,
          tool,
          error: 'Permission ask: ' + perm.reason,
          needs_approval: true,
          risk: 'always',
          permission: perm,
        };
      }
    }
  }

  if (
    toolNeedsApproval(
      ctx.autonomy,
      tool,
      ctx.approvedTools,
    )
  ) {
    return {
      ok: false,
      tool,
      error: 'Approval required for tool "' + tool + '" under autonomy=' + ctx.autonomy,
      needs_approval: true,
      risk: 'always',
    };
  }

  // Hard block: mutating tools need an approved PLAN.md when requirePlan is set.
  if (ctx.requirePlan && !ctx.planApproved) {
    const risk = toolRisk(tool);
    const pathHint = String(
      (p && (p.path || p.file || p.file_path || p.target || '')) || '',
    );
    const planWrite =
      /\/PLAN\.md$/i.test(pathHint) ||
      /\/plan\.md$/i.test(pathHint) ||
      /\/documents\/plans\//i.test(pathHint);
    const allow =
      risk === 'safe' ||
      tool === 'plan' ||
      tool === 'todo' ||
      tool === 'todo_write' ||
      tool === 'clarify' ||
      tool === 'ask_user_input' ||
      (planWrite &&
        (tool === 'write_file' ||
          tool === 'append_file' ||
          tool === 'patch_file' ||
          tool === 'apply_patch'));
    if (!allow) {
      return {
        ok: false,
        tool,
        error:
          'Plan not approved yet — mutating tool "' +
          tool +
          '" is blocked until the user Approves the PLAN.md.',
        needs_plan_approval: true,
        planPath: ctx.planPath || null,
      };
    }
  }

  if (tool === 'plan') {
    return {
      ok: true,
      tool,
      text: 'Plan recorded: ' + String(p.steps || ''),
    };
  }

  if (tool === 'todo') {
    const result = applyTodoAction(ctx.todos || [], p);
    if (result.ok) ctx.todos = result.todos;
    return result;
  }

  if (tool === 'todo_write') {
    const items = Array.isArray(p.todos) ? p.todos : [];
    const mapped = items.map((t, i) => {
      const status = String((t && t.status) || 'pending').toLowerCase();
      const owner = String((t && (t.owner || t.agent)) || 'build').toLowerCase();
      return {
        id: String((t && t.id) || 't' + (i + 1)),
        content: String((t && (t.content || t.active_form)) || ''),
        status:
          status === 'completed' || status === 'done'
            ? 'done'
            : status === 'in_progress'
              ? 'in_progress'
              : 'pending',
        owner,
        phase: String(
          (t && t.phase) ||
            (owner === 'explore'
              ? 'explore'
              : owner === 'verify'
                ? 'verify'
                : 'implement'),
        ),
        active_form: t && t.active_form,
      };
    });
    const result = applyTodoAction(ctx.todos || [], {
      action: 'set',
      items: mapped,
    });
    if (result.ok) ctx.todos = result.todos;
    return { ...result, tool: 'todo_write' };
  }

  if (tool === 'list_skills') {
    return {
      ok: true,
      tool,
      text: Object.keys(SKILL_GUIDES).join(', '),
      skills: Object.keys(SKILL_GUIDES),
    };
  }

  if (tool === 'use_skill') {
    const name = String(p.name || '').toLowerCase();
    const expanded = expandSkillGuide(name, p);
    if (!expanded) {
      return {
        ok: false,
        tool,
        error: 'Unknown skill: ' + name,
        available: Object.keys(SKILL_GUIDES),
      };
    }
    return {
      ok: true,
      tool,
      name: expanded.name,
      text: expanded.text,
      guide: expanded.guide,
      playbook: expanded.playbook,
    };
  }

  if (tool === 'clarify') {
    return clarifyTool(p);
  }

  if (tool === 'ask_user_input') {
    return clarifyTool({
      question: p.question,
      options: p.options || p.choices,
      recommended: p.recommended,
    });
  }

  if (tool === 'skill_view') {
    return skillViewTool(p);
  }

  if (tool === 'skill_manage') {
    return skillManageTool(p, ctx);
  }

  if (tool === 'web_extract') {
    return webExtractTool(p);
  }

  if (tool === 'session_search') {
    return sessionSearchTool(p, ctx);
  }

  if (tool === 'process_manage') {
    return Object.assign(
      { tool },
      processManage(p.action, p, { workspaceId, files: ctx.files }),
    );
  }

  if (tool === 'execute_code') {
    return executeCodeTool(p, ctx, {
      runJavascript: async (code) => {
        const result = await runCommand(
          ctx,
          'node -e ' + JSON.stringify(code),
          ctx.cwd,
        );
        return {
          ok: result.ok,
          tool: 'execute_code',
          language: 'javascript',
          output: result.output,
          error: result.error,
          code: result.code,
          text: result.output || result.error || '',
        };
      },
      runPython: async (code) => {
        const result = await runCommand(
          ctx,
          'python3 -c ' + JSON.stringify(code),
          ctx.cwd,
        );
        return {
          ok: result.ok,
          tool: 'execute_code',
          language: 'python',
          output: result.output,
          error: result.error,
          code: result.code,
          text: result.output || result.error || '',
        };
      },
      runShell: async (code) => {
        const result = await runCommand(ctx, code, ctx.cwd);
        return {
          ok: result.ok,
          tool: 'execute_code',
          language: 'shell',
          output: result.output,
          error: result.error,
          code: result.code,
          text: result.output || result.error || '',
        };
      },
    });
  }

  if (tool === 'vision_analyze') {
    return visionAnalyzeTool(p, ctx);
  }

  if (tool === 'video_analyze') {
    return videoAnalyzeTool(p, ctx);
  }

  if (tool === 'image_generate') {
    const res = await imageGenerateTool(p, ctx);
    if (res && res.ok && res.path) ctx.deliverySuccess = true;
    return res;
  }

  if (tool === 'text_to_speech') {
    const res = await textToSpeechTool(p, ctx);
    if (res && res.ok && res.path) ctx.deliverySuccess = true;
    return res;
  }

  if (tool === 'apply_patch') {
    const patchText = String(p.patch || p.diff || '');
    const applied = applyV4aPatchText(ctx.files, patchText);
    if (!applied.ok) {
      return { ok: false, tool, error: applied.error || 'patch failed', results: applied.results };
    }
    ctx.files = applied.files;
    const touched = (applied.results || [])
      .filter((r) => r.ok)
      .map((r) => r.path || r.to)
      .filter(Boolean);
    for (const path of touched) {
      const f = ctx.files[path];
      if (f && f.type === 'file') {
        ctx.filesTouched.push(path);
      }
    }
    const snap = await persistWorkspace(ctx, {
      files: ctx.files,
      prune: true,
    });
    ctx.deliverySuccess = touched.length > 0;
    return {
      ok: true,
      tool,
      results: applied.results,
      text: 'Applied V4A patch (' + touched.length + ' paths)',
      revision: snap.revision,
    };
  }

  if (tool === 'delegate_task') {
    return delegateTaskTool(p, ctx, {
      delegateRun: async ({ goal, context, model, userId, maxSteps }) => {
        const runners = {
          chatWorkerWithTools,
          parseToolCalls,
          cleanText,
          executeRemoteTool,
          applySpillToResult,
          shrinkToolResult,
          workspaceInventory,
        };
        // Parallel fan-out: goals:[{goal, agent, …}, …]
        if (Array.isArray(p.goals) && p.goals.length) {
          return Delegate.runParallelDelegates(
            Object.assign({}, runners, {
              goals: p.goals,
              context,
              thoroughness: p.thoroughness || ctx.thoroughness,
              maxSteps,
              model,
              userId,
              parentCtx: ctx,
            }),
          );
        }
        return Delegate.runDelegate(
          Object.assign({}, runners, {
            goal,
            context,
            agentName: p.agent || p.subagent || 'general',
            thoroughness: p.thoroughness || ctx.thoroughness,
            maxSteps,
            model,
            userId,
            parentCtx: ctx,
          }),
        );
      },
    });
  }

  if (isDesktopTool(tool)) {
    return runDesktopTool(tool, p, ctx);
  }

  if (tool === 'await_login') {
    const reason =
      String(p.reason || p.message || '').trim() ||
      'Complete login / 2FA / CAPTCHA in the browser, then resume.';
    return {
      ok: true,
      tool,
      await_login: true,
      reason,
      url: p.url || (ctx && ctx.lastBrowserUrl) || '',
      text: reason,
    };
  }

  if (
    tool === 'navigate' ||
    tool === 'computer' ||
    tool === 'read_page' ||
    tool === 'find' ||
    tool === 'form_input' ||
    tool === 'get_page_text' ||
    tool === 'tabs_create' ||
    tool === 'search_web' ||
    tool === 'list_frames' ||
    tool === 'switch_frame' ||
    tool === 'browser_navigate' ||
    tool === 'browser_click' ||
    tool === 'browser_type' ||
    tool === 'browser_press' ||
    tool === 'browser_screenshot' ||
    tool === 'browser_read' ||
    tool === 'browser_content' ||
    tool === 'browser_evaluate' ||
    tool === 'browser_wait' ||
    tool === 'browser_scroll' ||
    tool === 'browser' ||
    tool === 'browser_network' ||
    tool === 'browser_console' ||
    tool === 'ocr_image'
  ) {
    const result = await runBrowserTool(tool, p, ctx);
    return result;
  }

  if (tool === 'http_request') {
    const result = await httpRequest(p);
    return { tool, ...result };
  }

  if (tool === 'fetch_url') {
    return fetchUrl(p);
  }

  if (tool === 'download_file') {
    const dl = await downloadFile(p);
    if (!dl.ok || !dl.path) return { tool, ...dl };
    ensureParentDirs(ctx.files, dl.path);
    ctx.files[dl.path] = {
      path: dl.path,
      type: 'file',
      content: dl.content,
      encoding: dl.encoding || 'utf8',
      contentType: dl.content_type,
    };
    const put = await persistFilePut(
      ctx,
      {
        path: dl.path,
        type: 'file',
        content: dl.content,
        encoding: dl.encoding || 'utf8',
      },
      { allowEmpty: true },
    );
    return {
      ok: true,
      tool,
      path: dl.path,
      bytes: dl.bytes,
      content_type: dl.content_type,
      encoding: dl.encoding,
      artifact: true,
      text: 'Downloaded to ' + dl.path + ' (' + dl.bytes + ' bytes)',
      preview: dl.text,
      revision: put.revision,
    };
  }

  if (tool === 'upload_artifact') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const f = ctx.files[resolved.path];
    if (!f || f.type !== 'file') {
      return pathMissResult(tool, ctx.files, resolved.path);
    }
    const base = resolved.path.split('/').pop() || 'artifact';
    const dest =
      '/home/user/artifacts/' +
      String(p.title || base)
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .slice(0, 120);
    ensureParentDirs(ctx.files, dest);
    ctx.files[dest] = {
      path: dest,
      type: 'file',
      content: f.content || '',
      encoding: f.encoding || 'utf8',
      source: resolved.path,
    };
    const put = await persistFilePut(
      ctx,
      {
        path: dest,
        type: 'file',
        content: f.content || '',
        encoding: f.encoding || 'utf8',
      },
      { allowEmpty: true },
    );
    return {
      ok: true,
      tool,
      path: dest,
      source: resolved.path,
      artifact: true,
      title: p.title || base,
      text: 'Artifact ready at ' + dest,
      revision: put.revision,
    };
  }

  if (tool === 'patch_file') {
    const patchText = String(p.patch || p.diff || '');
    if (/\*\*\*\s*Begin Patch/i.test(patchText)) {
      const applied = applyV4aPatchText(ctx.files, patchText);
      if (!applied.ok) {
        return { ok: false, tool, error: applied.error || 'V4A patch failed', results: applied.results };
      }
      ctx.files = applied.files;
      const touched = (applied.results || [])
        .filter((r) => r.ok)
        .map((r) => r.path || r.to)
        .filter(Boolean);
      for (const path of touched) {
        const f = ctx.files[path];
        if (f && f.type === 'file') ctx.filesTouched.push(path);
      }
      const snap = await persistWorkspace(ctx, { files: ctx.files, prune: true });
      ctx.deliverySuccess = touched.length > 0;
      return {
        ok: true,
        tool,
        results: applied.results,
        text: 'Applied V4A patch via patch_file (' + touched.length + ' paths)',
        revision: snap.revision,
      };
    }
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const f = ctx.files[resolved.path];
    if (!f || f.type !== 'file') {
      return pathMissResult(tool, ctx.files, resolved.path);
    }
    const patched = patchFileContent(f.content || '', p);
    if (!patched.ok) return { ok: false, tool, error: patched.error };
    const prev = f.content || '';
    ctx.files[resolved.path] = {
      path: resolved.path,
      type: 'file',
      content: patched.content,
      previousContent: prev,
    };
    const put = await persistFilePut(
      ctx,
      {
        path: resolved.path,
        type: 'file',
        content: patched.content,
      },
      p,
    );
    return attachProjectRules(ctx, resolved.path, {
      ok: true,
      tool,
      path: resolved.path,
      replacements: patched.replacements || 1,
      text: 'Patched ' + resolved.path,
      revision: put.revision,
      previous: prev,
    });
  }

  if (tool === 'csv_read') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const f = ctx.files[resolved.path];
    if (!f || f.type !== 'file') {
      return pathMissResult(tool, ctx.files, resolved.path);
    }
    return { ...csvRead(f.content || '', p), path: resolved.path };
  }

  if (tool === 'csv_write') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const written = csvWrite(p.rows, p);
    if (!written.ok) return { ok: false, tool, error: written.error };
    ensureParentDirs(ctx.files, resolved.path);
    ctx.files[resolved.path] = {
      path: resolved.path,
      type: 'file',
      content: written.content,
    };
    const put = await persistFilePut(
      ctx,
      {
        path: resolved.path,
        type: 'file',
        content: written.content,
      },
      { allowEmpty: true },
    );
    return {
      ok: true,
      tool,
      path: resolved.path,
      rowCount: written.rowCount,
      text: 'Wrote CSV ' + resolved.path,
      revision: put.revision,
    };
  }

  if (tool === 'csv_query') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const f = ctx.files[resolved.path];
    if (!f || f.type !== 'file') {
      return pathMissResult(tool, ctx.files, resolved.path);
    }
    return { ...csvQuery(f.content || '', p), path: resolved.path };
  }

  if (tool === 'memory_get') {
    return { tool, ...(await userMemory.memoryGet(ctx.userId, p.key)) };
  }
  if (tool === 'memory_set') {
    return {
      tool,
      ...(await userMemory.memorySet(ctx.userId, p.key, p.value)),
    };
  }
  if (tool === 'memory_delete') {
    return { tool, ...(await userMemory.memoryDelete(ctx.userId, p.key)) };
  }

  if (tool === 'schedule_create' || tool === 'remind') {
    return {
      tool,
      ...(await userMemory.scheduleCreate(ctx.userId, p)),
    };
  }
  if (tool === 'schedule_list') {
    return { tool, ...(await userMemory.scheduleList(ctx.userId)) };
  }
  if (tool === 'schedule_cancel') {
    return {
      tool,
      ...(await userMemory.scheduleCancel(ctx.userId, p.id)),
    };
  }
  if (tool === 'schedule_due') {
    return { tool, ...(await userMemory.scheduleDue(ctx.userId)) };
  }

  if (tool === 'test_connection') {
    if (!ctx.userId) {
      return { ok: false, tool, error: 'Signed-in user required' };
    }
    return {
      tool,
      ...(await testByokProvider(ctx.userId, p.provider)),
    };
  }

  if (tool === 'list_connectors') {
    if (!ctx.userId) {
      return { ok: false, tool, error: 'Signed-in user required for connectors' };
    }
    const doc = await users.getConnectorsDoc(ctx.userId);
    const { listStatus, CONNECTOR_PROVIDERS } = require('./connectors');
    const status = listStatus(doc);
    const linked = CONNECTOR_PROVIDERS.filter((x) => status[x] && status[x].connected);
    return {
      ok: true,
      tool,
      connectors: status,
      linked,
      text:
        linked.length
          ? 'Connected: ' + linked.join(', ')
          : 'No app connectors linked. Ask the user to open Settings → Integrations (GitHub, Vercel, Supabase, Firebase).',
    };
  }

  if (tool === 'connector_status') {
    if (!ctx.userId) {
      return { ok: false, tool, error: 'Signed-in user required' };
    }
    const provider = String(p.provider || '').toLowerCase();
    const { listStatus, testConnector } = require('./connectors');
    const doc = await users.getConnectorsDoc(ctx.userId);
    const status = listStatus(doc)[provider];
    if (!status) {
      return { ok: false, tool, error: 'Unknown provider: ' + provider };
    }
    let live = null;
    if (p.test && status.connected) {
      live = await testConnector(ctx.userId, provider);
    }
    return {
      ok: true,
      tool,
      provider,
      connected: !!status.connected,
      meta: status.meta,
      live: live,
      text: status.connected
        ? provider +
          ' connected' +
          (status.meta && status.meta.login ? ' as ' + status.meta.login : '')
        : provider + ' not connected — Settings → Integrations',
    };
  }

  if (tool === 'connector_request') {
    if (!ctx.userId) {
      return { ok: false, tool, error: 'Signed-in user required' };
    }
    const { connectorRequest } = require('./connectors');
    return connectorRequest(ctx.userId, p);
  }

  if (tool === 'create_pull_request') {
    const pol = ctx.orgPolicy || OrgPolicy.loadOrgPolicy();
    if (pol.requireCiForPr && !ctx.ciOk) {
      return {
        ok: false,
        tool,
        error:
          'Org policy requireCiForPr: call get_ci_status and ensure ciOk before create_pull_request',
      };
    }
    if (pol.requireTests && !ctx.testsOk) {
      return {
        ok: false,
        tool,
        error: 'Org policy requireTests: run_tests must pass before create_pull_request',
      };
    }
    const result = await GithubPr.createPullRequest(ctx, p);
    if (result.ok) {
      await persistWorkspace(ctx, {
        lastPr: ctx.lastPr,
        repo: ctx.repo,
      });
      if (typeof ctx.emit === 'function') {
        ctx.emit({ type: 'pr', pr: ctx.lastPr, action: 'create' });
      }
    }
    return Object.assign({ tool }, result);
  }

  if (tool === 'list_pull_requests') {
    const result = await GithubPr.listPullRequests(ctx, p);
    return Object.assign({ tool }, result);
  }

  if (tool === 'get_pull_request') {
    const result = await GithubPr.getPullRequest(ctx, p);
    return Object.assign({ tool }, result);
  }

  if (tool === 'review_pull_request') {
    const result = await GithubPr.reviewPullRequest(ctx, p);
    if (result.ok && typeof ctx.emit === 'function') {
      ctx.emit({
        type: 'pr',
        pr: ctx.lastPr || { number: result.number, html_url: result.html_url },
        action: 'review',
        event: result.event,
      });
    }
    if (result.ok) {
      await persistWorkspace(ctx, { lastPr: ctx.lastPr, repo: ctx.repo });
    }
    return Object.assign({ tool }, result);
  }

  if (tool === 'get_ci_status') {
    const result = await GithubPr.getCiStatus(ctx, p);
    if (result.ok) {
      await persistWorkspace(ctx, {
        lastCi: ctx.lastCi,
        ciOk: !!ctx.ciOk,
        repo: ctx.repo,
      });
      if (typeof ctx.emit === 'function') {
        ctx.emit({
          type: 'pr',
          action: 'ci',
          ciOk: !!ctx.ciOk,
          lastCi: ctx.lastCi,
          pr: ctx.lastPr || null,
        });
      }
    }
    return Object.assign({ tool }, result);
  }

  if (tool === 'execute_command') {
    const cmd = String(p.cmd || p.command || '').trim();
    if (!cmd) {
      return { ok: false, tool, error: 'cmd/command required' };
    }
    const cwdRaw = p.cwd || p.workdir;
    let cwd = cwdRaw || ctx.cwd;
    if (cwdRaw) {
      const resolved = resolveWorkspacePath(cwdRaw, ctx.cwd);
      if (resolved.ok) cwd = resolved.path;
    }
    if (p.mode) ctx.shellMode = p.mode;
    if (p.approved) ctx.shellApproved = true;
    const result = await runCommand(ctx, cmd, cwd, {
      mode: p.mode,
      timeoutMs: p.timeoutMs || p.timeout,
      network: p.network,
      pack: p.pack,
      approved: p.approved,
    });
    const spilled = await spillIfNeeded(
      result.output || '',
      {
        files: ctx.files,
        filesTouched: ctx.filesTouched,
        workspaceId,
        putFile,
      },
      { tool: 'execute_command' },
    );
    return {
      ok: result.ok,
      tool,
      output: spilled.text,
      error: result.error,
      code: result.code,
      cwd: result.cwd || cwd,
      durationMs: result.durationMs,
      mode: result.mode,
      truncated: !!(spilled.truncated || result.truncated),
      omitted: spilled.omitted || result.omitted || 0,
      spill_path: spilled.spill_path || null,
      killed: !!result.killed,
      needs_input: !!result.needs_input,
      sandbox: !!result.sandbox,
      synced: !!result.synced,
      command: cmd,
    };
  }

  if (tool === 'execute_command_cancel') {
    if (ctx.shellAbort) {
      try {
        ctx.shellAbort.abort();
      } catch {
        /* ignore */
      }
    }
    return { ok: true, tool, text: 'Cancel signal sent' };
  }

  if (tool === 'shell_open') {
    const opened = shellSessions.openSession({
      workspaceId: ctx.workspaceId,
      files: ctx.files,
      cwd: p.cwd || ctx.cwd,
      shell: p.shell,
    });
    if (opened.ok) ctx.activeShellId = opened.session_id;
    return { tool, ...opened };
  }

  if (tool === 'shell_write') {
    const id = p.session_id || p.id || ctx.activeShellId;
    return { tool, ...shellSessions.writeSession(id, p.data || p.text || p.input) };
  }

  if (tool === 'shell_read') {
    const id = p.session_id || p.id || ctx.activeShellId;
    const read = await shellSessions.readSession(id, p);
    if (read.needs_input) {
      return {
        tool,
        ...read,
        await_shell_input: true,
        reason: 'Shell is waiting for interactive input',
      };
    }
    return { tool, ...read };
  }

  if (tool === 'shell_close') {
    const id = p.session_id || p.id || ctx.activeShellId;
    const closed = shellSessions.closeSession(id);
    if (ctx.activeShellId === id) ctx.activeShellId = null;
    return { tool, ...closed };
  }

  if (tool === 'run_javascript') {
    const code = String(p.code || p.source || '');
    if (!code) return { ok: false, tool, error: 'code required' };
    const result = await runCommand(
      ctx,
      'node -e ' + JSON.stringify(code),
      ctx.cwd,
    );
    return {
      ok: result.ok,
      tool,
      output: result.output,
      error: result.error,
      code: result.code,
    };
  }

  if (tool === 'run_python') {
    const code = String(p.code || p.source || '');
    if (!code) return { ok: false, tool, error: 'code required' };
    const result = await runCommand(
      ctx,
      'python3 -c ' + JSON.stringify(code),
      ctx.cwd,
    );
    return {
      ok: result.ok,
      tool,
      output: result.output,
      error: result.error,
      code: result.code,
    };
  }

  if (tool === 'write_file' || tool === 'create_document' || tool === 'create_pdf' || tool === 'append_file') {
    let filePath;
    let content;
    let binaryBase64 = null;
    if (tool === 'create_pdf') {
      const { buildSimplePdf } = require('./simple-pdf');
      const safe =
        String(p.title || 'document')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'document';
      filePath = '/home/user/documents/' + safe + '.pdf';
      const pdfBuf = buildSimplePdf({
        title: p.title || 'Document',
        content: String(p.content || ''),
      });
      binaryBase64 = pdfBuf.toString('base64');
      content = pdfBuf.toString('binary');
      ensureParentDirs(ctx.files, filePath);
      ctx.files[filePath] = {
        path: filePath,
        type: 'file',
        content: binaryBase64,
        encoding: 'base64',
        mime: 'application/pdf',
      };
      const put = await persistFilePut(
        ctx,
        {
          path: filePath,
          type: 'file',
          content: binaryBase64,
          encoding: 'base64',
          mime: 'application/pdf',
        },
        { allowEmpty: true },
      );
      return {
        ok: true,
        tool,
        path: filePath,
        title: p.title || 'Document',
        mime: 'application/pdf',
        bytes: pdfBuf.length,
        text: 'Created PDF ' + filePath + ' (' + pdfBuf.length + ' bytes)',
        artifact: true,
        revision: put.revision,
      };
    }
    if (tool === 'create_document') {
      const safe =
        String(p.title || 'document')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'document';
      filePath = '/home/user/documents/' + safe + '.md';
      content = '# ' + (p.title || 'Document') + '\n\n' + String(p.content || '');
    } else {
      const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
      if (!resolved.ok) return { ok: false, tool, error: resolved.error };
      filePath = resolved.path;
      if (tool === 'append_file') {
        const existing =
          ctx.files[filePath] && ctx.files[filePath].type === 'file'
            ? ctx.files[filePath].content || ''
            : '';
        content = existing + String(p.content != null ? p.content : '');
      } else {
        if (p.content == null) {
          return { ok: false, tool, error: 'content required for write_file' };
        }
        content = unescapeFileContent(String(p.content));
        // Model sometimes writes the whole {"index.html":"…\\n…"} blob as one file.
        const unwrapped = unwrapFilesJsonBlob(content);
        if (
          unwrapped &&
          unwrapped.files &&
          unwrapped.files.length === 1 &&
          /\.(html?|css|js|md)$/i.test(unwrapped.files[0].relativePath || '')
        ) {
          content = unescapeFileContent(unwrapped.files[0].content);
        } else if (
          unwrapped &&
          unwrapped.files &&
          unwrapped.files.length > 1
        ) {
          return {
            ok: false,
            tool,
            error:
              'content looks like a multi-file JSON blob. Call write_file once per file with the raw HTML/CSS/JS body (real newlines), not a JSON map.',
            hint: 'Example paths: ' + unwrapped.files.map((f) => f.relativePath).slice(0, 4).join(', '),
          };
        }
        // Reject obvious JSON-escaped single-line HTML dumps
        if (
          /\\n/.test(content) &&
          content.indexOf('\n') < 0 &&
          /<!DOCTYPE|<html[\s>]/i.test(content)
        ) {
          content = unescapeFileContent(content);
        }
        const blocked = Sync.emptyWriteBlocked(ctx.files[filePath], content, p);
        if (blocked) {
          return {
            ok: false,
            tool,
            error: blocked.error,
            code: 'EMPTY_WRITE_BLOCKED',
          };
        }
      }
    }

    const lockErr = assertActiveProjectLock(ctx, filePath);
    if (lockErr) return { ok: false, tool, error: lockErr };
    if (isUnderProjects(filePath) && (!ctx.activeProject || !ctx.lockActiveProject)) {
      const slug = slugFromPath(filePath);
      if (slug) {
        ctx.activeProject = slug;
        ctx.lockActiveProject = true;
      }
    }

    ensureParentDirs(ctx.files, filePath);
    const prev =
      ctx.files[filePath] && ctx.files[filePath].type === 'file'
        ? ctx.files[filePath].content || ''
        : null;
    ctx.files[filePath] = {
      path: filePath,
      type: 'file',
      content: String(content),
      encoding: 'utf8',
      previousContent: prev != null ? prev : undefined,
    };

    let projectInfo = null;
    if (isUnderProjects(filePath) && !/\/AGENTS\.md$/i.test(filePath)) {
      projectInfo = noteProjectWrite(ctx, filePath, {
        goal: (ctx.briefing && ctx.briefing.goal) || '',
        agentsMd: ctx.skipAgentsMd ? false : undefined,
      });
    } else if (isUnderProjects(filePath)) {
      const slug = slugFromPath(filePath);
      if (slug) {
        ctx.projects = ctx.projects || detectProjects(ctx.files);
        if (!ctx.lockActiveProject || !ctx.activeProject) {
          ctx.activeProject = slug;
        }
        ctx.cwd = '/home/user/projects/' + (ctx.activeProject || slug);
      }
    }

    const put = await persistFilePut(
      ctx,
      {
        path: filePath,
        type: 'file',
        content: String(content),
        encoding: 'utf8',
      },
      p,
    );
    if (projectInfo && projectInfo.agentsCreated && ctx.files[projectInfo.agentsMd]) {
      await persistFilePut(ctx, ctx.files[projectInfo.agentsMd], { allowEmpty: true });
      if (ctx.files[projectInfo.root]) {
        await persistFilePut(ctx, ctx.files[projectInfo.root], { allowEmpty: true });
      }
    }
    const saved = put.saved;
    return attachProjectRules(ctx, filePath, {
      ok: true,
      tool,
      path: filePath,
      title: p.title || undefined,
      text: (tool === 'append_file' ? 'Appended ' : 'Wrote ') + filePath,
      previous:
        saved && saved._previousContent != null
          ? saved._previousContent
          : prev,
      content: String(content).slice(0, 500),
      artifact: tool === 'create_document',
      revision: put.revision,
      project: projectInfo
        ? {
            slug: projectInfo.slug,
            root: projectInfo.root,
            agentsMd: projectInfo.agentsMd,
            agentsCreated: !!projectInfo.agentsCreated,
          }
        : undefined,
    });
  }

  if (tool === 'view_file_outline') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const f = ctx.files[resolved.path];
    if (!f || f.type !== 'file') {
      return pathMissResult(tool, ctx.files, resolved.path);
    }
    const outline = FileOutline.outlineFile(resolved.path, f.content || '', {
      max: p.max,
    });
    return Object.assign({ ok: true, tool: tool }, outline);
  }

  if (tool === 'read_file') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const f = ctx.files[resolved.path];
    if (!f || f.type !== 'file') {
      return pathMissResult(tool, ctx.files, resolved.path);
    }
    const full = String(f.content || '');
    const lines = full.split('\n');
    const totalLines = lines.length;
    let startLine = 1;
    let endLine = totalLines;
    let ranged = false;
    if (p.start_line != null || p.end_line != null || p.offset != null || p.limit != null) {
      ranged = true;
      if (p.offset != null) {
        startLine = Math.max(1, Number(p.offset) + 1);
      } else if (p.start_line != null) {
        startLine = Math.max(1, Number(p.start_line) || 1);
      }
      if (p.limit != null) {
        endLine = startLine + Math.max(1, Number(p.limit) || 1) - 1;
      } else if (p.end_line != null) {
        endLine = Math.max(startLine, Number(p.end_line) || startLine);
      }
      endLine = Math.min(totalLines, endLine);
      startLine = Math.min(startLine, Math.max(1, totalLines));
    }
    // Soft cap full-file dumps into the model context
    const HARD_CAP = 400;
    if (!ranged && totalLines > HARD_CAP) {
      ranged = true;
      startLine = 1;
      endLine = HARD_CAP;
    }
    const slice = ranged
      ? lines.slice(startLine - 1, endLine).join('\n')
      : full;
    const out = {
      ok: true,
      tool,
      path: resolved.path,
      content: slice,
      total_lines: totalLines,
    };
    if (ranged) {
      out.start_line = startLine;
      out.end_line = endLine;
      out.truncated = endLine < totalLines || startLine > 1;
      if (out.truncated) {
        out.hint =
          'Partial read lines ' +
          startLine +
          '-' +
          endLine +
          ' of ' +
          totalLines +
          '. Use view_file_outline or another ranged read_file for more.';
      }
    }
    // Nested AGENTS.md reminder (OpenCode-style) — once per path per run
    if (!ctx._agentsAttached) ctx._agentsAttached = new Set();
    const nested = SelfAwareness.findNearestAgentsMd(
      ctx.files,
      resolved.path,
      ctx._agentsAttached,
    );
    if (nested) {
      ctx._agentsAttached.add(nested.path);
      out.system_reminder = nested.text;
      out.content =
        String(out.content || '') +
        (String(out.content || '').endsWith('\n') ? '\n' : '\n\n') +
        nested.text;
    }
    // Globbed project rules (.chatre/rules, .cursor/rules)
    if (!ctx._rulesAttached) ctx._rulesAttached = new Set();
    const rules = ProjectRules.matchingRules(ctx.files, resolved.path).filter(
      function (r) {
        return !ctx._rulesAttached.has(r.path);
      },
    );
    if (rules.length) {
      rules.forEach(function (r) {
        ctx._rulesAttached.add(r.path);
      });
      const reminder = ProjectRules.formatRulesReminder(rules);
      out.project_rules = rules.map(function (r) {
        return r.path;
      });
      out.content =
        String(out.content || '') +
        (String(out.content || '').endsWith('\n') ? '\n' : '\n\n') +
        reminder;
      out.system_reminder = (out.system_reminder || '') + '\n' + reminder;
    }
    return out;
  }

  if (tool === 'create_directory') {
    const resolved = resolveWorkspacePath(p.path, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const lockErr = assertActiveProjectLock(ctx, resolved.path);
    if (lockErr) return { ok: false, tool, error: lockErr };
    ensureParentDirs(ctx.files, resolved.path + '/.keep');
    ctx.files[resolved.path] = {
      path: resolved.path,
      type: 'dir',
      children: ctx.files[resolved.path]
        ? ctx.files[resolved.path].children || []
        : [],
    };
    let projectInfo = null;
    if (isUnderProjects(resolved.path)) {
      const slug = slugFromPath(resolved.path);
      if (slug) {
        projectInfo = ensureProject(ctx, slug, {
          goal: (ctx.briefing && ctx.briefing.goal) || '',
        });
        if (!ctx.lockActiveProject || !ctx.activeProject) {
          ctx.activeProject = slug;
          ctx.lockActiveProject = true;
        }
      }
    }
    const put = await persistFilePut(ctx, ctx.files[resolved.path], {
      allowEmpty: true,
    });
    if (projectInfo && projectInfo.agentsCreated && ctx.files[projectInfo.agentsMd]) {
      await persistFilePut(ctx, ctx.files[projectInfo.agentsMd], { allowEmpty: true });
    }
    if (
      /\/PLAN\.md$/i.test(resolved.path) ||
      /\/plan\.md$/i.test(resolved.path) ||
      /\/documents\/plans\//i.test(resolved.path)
    ) {
      ctx.planPath = resolved.path;
      if (ctx.blackboard) {
        ctx.blackboard.planPath = resolved.path;
      }
    }
    return {
      ok: true,
      tool,
      path: resolved.path,
      text: 'Created ' + resolved.path,
      revision: put.revision,
      project: projectInfo
        ? { slug: projectInfo.slug, root: projectInfo.root, agentsMd: projectInfo.agentsMd }
        : undefined,
    };
  }

  if (tool === 'delete_file') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const lockErr = assertActiveProjectLock(ctx, resolved.path);
    if (lockErr) return { ok: false, tool, error: lockErr };
    if (!ctx.files[resolved.path]) {
      // Still try store delete for orphans
      const orphan = await deleteFileTree(workspaceId, ctx.files, resolved.path, {
        expectedRevision: ctx.revision,
        cwd: ctx.cwd,
        git: ctx.git,
        projects: ctx.projects,
        activeProject: ctx.activeProject,
      }).catch(async (e) => {
        if (e && e.code === 'REVISION_CONFLICT') {
          return deleteFileTree(workspaceId, ctx.files, resolved.path, {
            cwd: ctx.cwd,
            git: ctx.git,
            projects: ctx.projects,
            activeProject: ctx.activeProject,
          });
        }
        throw e;
      });
      ctx.revision = orphan.revision;
      ctx.files = orphan.files;
      if (typeof ctx.emit === 'function') {
        (orphan.deleted || []).forEach((dp) => {
          ctx.emit({
            type: 'file_event',
            op: 'delete',
            path: dp,
            revision: orphan.revision,
          });
        });
      }
      return {
        ok: true,
        tool,
        path: resolved.path,
        text: 'Deleted ' + resolved.path,
        revision: orphan.revision,
      };
    }
    const result = await deleteFileTree(workspaceId, ctx.files, resolved.path, {
      expectedRevision: ctx.revision,
      cwd: ctx.cwd,
      git: ctx.git,
      projects: ctx.projects,
      activeProject: ctx.activeProject,
    }).catch(async (e) => {
      if (e && e.code === 'REVISION_CONFLICT') {
        return deleteFileTree(workspaceId, ctx.files, resolved.path, {
          cwd: ctx.cwd,
          git: ctx.git,
          projects: ctx.projects,
          activeProject: ctx.activeProject,
        });
      }
      throw e;
    });
    ctx.files = result.files;
    ctx.revision = result.revision;
    if (typeof ctx.emit === 'function') {
      (result.deleted || []).forEach((dp) => {
        ctx.emit({
          type: 'file_event',
          op: 'delete',
          path: dp,
          revision: result.revision,
        });
      });
    }
    return {
      ok: true,
      tool,
      path: resolved.path,
      text: 'Deleted ' + resolved.path,
      revision: result.revision,
      deleted: result.deleted,
    };
  }

  if (tool === 'copy_file') {
    const srcRes = resolveWorkspacePath(p.src || p.source, ctx.cwd);
    const destRes = resolveWorkspacePath(p.dest || p.destination, ctx.cwd);
    if (!srcRes.ok) return { ok: false, tool, error: srcRes.error };
    if (!destRes.ok) return { ok: false, tool, error: destRes.error };
    const src = srcRes.path;
    const dest = destRes.path;
    const srcEntry = ctx.files[src];
    if (!srcEntry) {
      return pathMissResult(tool, ctx.files, src);
    }
    if (ctx.files[dest]) {
      return { ok: false, tool, error: 'Destination exists: ' + dest };
    }
    const lockErr = assertActiveProjectLock(ctx, dest);
    if (lockErr) return { ok: false, tool, error: lockErr };

    const copied = [];
    const copyNode = (from, to) => {
      const entry = ctx.files[from];
      if (!entry) return;
      if (entry.type === 'dir') {
        ensureParentDirs(ctx.files, to + '/.keep');
        ctx.files[to] = {
          path: to,
          type: 'dir',
          children: Array.isArray(entry.children) ? [...entry.children] : [],
        };
        copied.push(to);
        (entry.children || []).forEach((child) => {
          const childFrom = from === '/' ? '/' + child : from + '/' + child;
          const childTo = to === '/' ? '/' + child : to + '/' + child;
          copyNode(childFrom, childTo);
        });
        return;
      }
      ensureParentDirs(ctx.files, to);
      ctx.files[to] = {
        path: to,
        type: 'file',
        content: entry.content || '',
        encoding: entry.encoding || 'utf8',
        mime: entry.mime,
      };
      copied.push(to);
    };
    copyNode(src, dest);

    for (const path of copied) {
      const f = ctx.files[path];
      if (f && f.type === 'file') {
        await persistFilePut(
          ctx,
          {
            path,
            type: 'file',
            content: f.content || '',
            encoding: f.encoding || 'utf8',
          },
          { allowEmpty: true },
        );
        ctx.filesTouched.push(path);
      }
    }
    const snap = await persistWorkspace(ctx, { files: ctx.files });
    return {
      ok: true,
      tool,
      src,
      path: dest,
      dest,
      copied,
      text: 'Copied ' + src + ' to ' + dest,
      revision: snap.revision,
    };
  }

  if (tool === 'export_document') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const f = ctx.files[resolved.path];
    if (!f || f.type !== 'file') {
      return pathMissResult(tool, ctx.files, resolved.path);
    }
    const name = resolved.path.split('/').pop() || 'export.txt';
    const mime =
      f.mime ||
      (/\.md$/i.test(name)
        ? 'text/markdown'
        : /\.html?$/i.test(name)
          ? 'text/html'
          : /\.json$/i.test(name)
            ? 'application/json'
            : /\.pdf$/i.test(name)
              ? 'application/pdf'
              : 'text/plain');
    if (typeof ctx.emit === 'function') {
      ctx.emit({
        type: 'file_event',
        op: 'export',
        path: resolved.path,
        filename: name,
        mime,
        download: true,
        revision: ctx.revision,
      });
    }
    return {
      ok: true,
      tool,
      path: resolved.path,
      filename: name,
      mime,
      downloaded: true,
      artifact: true,
      content: String(f.content || '').slice(0, 500),
      text: 'Exported ' + resolved.path + ' for download',
    };
  }

  if (tool === 'list_directory') {
    const resolved = resolveWorkspacePath(
      p.path || ctx.cwd || '/home/user',
      ctx.cwd,
    );
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const entry = ctx.files[resolved.path];
    if (!entry) return { ok: false, tool, error: 'Missing: ' + resolved.path };
    return {
      ok: true,
      tool,
      path: resolved.path,
      entries:
        entry.type === 'dir'
          ? entry.children || []
          : [resolved.path.split('/').pop()],
    };
  }

  if (tool === 'view_tree') {
    const root = resolveWorkspacePath(p.path || '/', ctx.cwd);
    const prefix = root.ok ? root.path : '/';
    const keys = Object.keys(ctx.files || {})
      .filter((k) => k === prefix || k.startsWith(prefix === '/' ? '/' : prefix + '/'))
      .sort();
    return { ok: true, tool, path: prefix, output: keys.join('\n') };
  }

  if (tool === 'find_files') {
    const needle = String(p.pattern || p.query || p.needle || '').toLowerCase();
    if (!needle) return { ok: false, tool, error: 'pattern required' };
    const matches = Object.keys(ctx.files || {})
      .filter(
        (k) =>
          ctx.files[k] &&
          ctx.files[k].type === 'file' &&
          k.toLowerCase().includes(needle),
      )
      .sort();
    return { ok: true, tool, matches, output: matches.join('\n') || '(none)' };
  }

  if (tool === 'search_code') {
    const needle = String(p.pattern || p.query || p.needle || '');
    if (!needle) return { ok: false, tool, error: 'pattern required' };
    const scope = p.path
      ? resolveWorkspacePath(p.path, ctx.cwd)
      : { ok: true, path: RepoMode.projectRootVirt(ctx) };
    if (!scope.ok) return { ok: false, tool, error: scope.error };
    try {
      if (ctx.workspaceId) {
        const rg = RepoMode.runRg(ctx, needle, scope.path);
        if (rg && rg.hits != null) {
          return {
            ok: true,
            tool,
            hits: rg.hits,
            output: rg.output,
            engine: 'rg',
            truncated: !!rg.truncated,
          };
        }
      }
    } catch (e) {
      /* fall through to memory scan */
    }
    const hits = [];
    for (const [pathKey, f] of Object.entries(ctx.files || {})) {
      if (!f || f.type !== 'file') continue;
      if (
        scope.path !== '/' &&
        pathKey !== scope.path &&
        !pathKey.startsWith(scope.path + '/')
      ) {
        continue;
      }
      const lines = String(f.content || '').split('\n');
      lines.forEach((line, i) => {
        if (line.includes(needle)) {
          hits.push(pathKey + ':' + (i + 1) + ': ' + line.slice(0, 200));
        }
      });
      if (hits.length > 80) break;
    }
    return {
      ok: true,
      tool,
      hits: hits.length,
      output: hits.join('\n') || '(no matches)',
      engine: 'memory',
    };
  }

  if (tool === 'git_clone' || tool === 'repo_open') {
    const result = RepoMode.gitClone(ctx, p);
    if (!result.ok) return { ok: false, tool, error: result.error, output: result.output };
    ctx.git = ctx.git || {};
    ctx.git.initialized = true;
    ctx.git.branch = (ctx.repo && ctx.repo.branch) || ctx.git.branch || 'main';
    const snap = await persistWorkspace(ctx, {
      files: ctx.files,
      cwd: ctx.cwd,
      git: ctx.git,
      projects: ctx.projects || detectProjects(ctx.files),
      activeProject: ctx.activeProject,
      repo: ctx.repo,
    });
    return {
      ok: true,
      tool,
      text: result.text,
      path: result.path,
      slug: result.slug,
      repo: ctx.repo,
      status: result.status,
      revision: snap.revision,
      refreshed: !!result.refreshed,
    };
  }

  if (tool === 'git_diff') {
    if (RepoMode.isRepoMode(ctx)) {
      const diff = RepoMode.repoDiff(ctx, {
        cached: !!(p.cached || p.staged),
        path: p.path || p.file || null,
      });
      return {
        ok: !!diff.ok,
        tool,
        output: diff.output || '',
        truncated: !!diff.truncated,
        error: diff.error || null,
      };
    }
    return { ok: true, tool, output: '(simulated git — no disk .git; use git_clone)', simulated: true };
  }

  if (tool === 'run_tests') {
    const result = RepoMode.runTests(ctx, p);
    const snap = await persistWorkspace(ctx, {
      files: ctx.files,
      repo: ctx.repo,
      lastTest: ctx.lastTest,
      testsOk: !!ctx.testsOk,
      lastDiagnostics: ctx.lastDiagnostics,
      runConfigs: ctx.runConfigs,
      git: ctx.git,
      activeProject: ctx.activeProject,
    });
    return Object.assign({ tool, revision: snap.revision }, result);
  }

  if (tool === 'repo_diagnostics') {
    const result = RepoMode.repoDiagnostics(ctx);
    const snap = await persistWorkspace(ctx, {
      files: ctx.files,
      repo: ctx.repo,
      lastDiagnostics: ctx.lastDiagnostics,
      runConfigs: ctx.runConfigs,
      lastTest: ctx.lastTest,
      testsOk: !!ctx.testsOk,
      git: ctx.git,
      activeProject: ctx.activeProject,
    });
    return Object.assign({ tool, revision: snap.revision }, result);
  }

  if (tool === 'git_init') {
    if (p.real || p.disk || RepoMode.isRepoMode(ctx)) {
      const root =
        (p.path && resolveWorkspacePath(p.path, ctx.cwd).ok
          ? resolveWorkspacePath(p.path, ctx.cwd).path
          : null) || RepoMode.projectRootVirt(ctx);
      const result = RepoMode.gitInitReal(ctx, root);
      if (!result.ok) return { ok: false, tool, error: result.error };
      ctx.git = ctx.git || {};
      ctx.git.initialized = true;
      ctx.git.branch = 'main';
      ctx.git.staged = ctx.git.staged || [];
      ctx.git.commits = ctx.git.commits || [];
      let slug =
        slugFromPath(ctx.cwd) ||
        ctx.activeProject ||
        projectSlug(
          (ctx.briefing && ctx.briefing.goal) || p.path || 'repo',
          ctx.briefing && ctx.briefing.goal,
        );
      const info = ensureProject(ctx, slug, {
        goal: (ctx.briefing && ctx.briefing.goal) || 'Git repository',
        stack: 'git',
      });
      const snap = await persistWorkspace(ctx, {
        git: ctx.git,
        cwd: ctx.cwd,
        files: ctx.files,
        projects: ctx.projects,
        activeProject: ctx.activeProject,
        repo: ctx.repo,
      });
      return {
        ok: true,
        tool,
        text: result.text + ' (project `' + info.slug + '`)',
        path: info.root,
        revision: snap.revision,
        repo: ctx.repo,
        project: { slug: info.slug, root: info.root, agentsMd: info.agentsMd },
      };
    }
    ctx.git = ctx.git || {};
    ctx.git.initialized = true;
    ctx.git.branch = ctx.git.branch || 'main';
    ctx.git.staged = ctx.git.staged || [];
    ctx.git.commits = ctx.git.commits || [];

    let slug =
      slugFromPath(ctx.cwd) ||
      ctx.activeProject ||
      projectSlug(
        (ctx.briefing && ctx.briefing.goal) || p.path || 'repo',
        ctx.briefing && ctx.briefing.goal,
      );
    const info = ensureProject(ctx, slug, {
      goal: (ctx.briefing && ctx.briefing.goal) || 'Git repository',
      stack: 'git',
    });
    const snap = await persistWorkspace(ctx, {
      git: ctx.git,
      cwd: ctx.cwd,
      files: ctx.files,
      projects: ctx.projects,
      activeProject: ctx.activeProject,
    });
    return {
      ok: true,
      tool,
      text:
        'Initialized git repository for project `' +
        info.slug +
        '` at ' +
        info.root +
        (info.agentsCreated ? ' (wrote AGENTS.md)' : ''),
      path: info.root,
      revision: snap.revision,
      project: { slug: info.slug, root: info.root, agentsMd: info.agentsMd },
    };
  }

  if (tool === 'git_add') {
    if (RepoMode.isRepoMode(ctx)) {
      const target = p.path || '.';
      const args =
        target === '.' || target === './' || target === '*'
          ? ['add', '-A']
          : ['add', '--', String(target).replace(/^\//, '')];
      const res = RepoMode.runGit(ctx, args);
      RepoMode.syncCollect(ctx);
      const st = RepoMode.repoStatus(ctx);
      const snap = await persistWorkspace(ctx, {
        files: ctx.files,
        git: ctx.git,
        repo: ctx.repo,
      });
      return {
        ok: !!res.ok,
        tool,
        text: res.ok ? 'Staged ' + target : res.error || 'git add failed',
        output: res.output,
        status: st,
        revision: snap.revision,
        error: res.ok ? null : res.error,
      };
    }
    ctx.git = ctx.git || {
      initialized: true,
      staged: [],
      commits: [],
      branch: 'main',
    };
    ctx.git.initialized = true;
    ctx.git.staged = ctx.git.staged || [];
    let target = p.path || '.';
    if (target === '.' || target === './' || target === '*') {
      const files = Object.keys(ctx.files || {}).filter(
        (k) => ctx.files[k] && ctx.files[k].type === 'file',
      );
      files.forEach((f) => {
        if (!ctx.git.staged.includes(f)) ctx.git.staged.push(f);
      });
      target = files.length + ' files';
    } else {
      const resolved = resolveWorkspacePath(target, ctx.cwd);
      if (resolved.ok) target = resolved.path;
      if (!ctx.git.staged.includes(target)) ctx.git.staged.push(target);
    }
    const snap = await persistWorkspace(ctx, { git: ctx.git });
    return { ok: true, tool, text: 'Staged ' + target, revision: snap.revision };
  }

  if (tool === 'git_commit') {
    if (RepoMode.isRepoMode(ctx)) {
      const msg = String(p.message || '').trim();
      if (!msg) return { ok: false, tool, error: 'message required' };
      const res = RepoMode.runGit(ctx, [
        'commit',
        '-m',
        msg,
        '--allow-empty-message',
      ]);
      // retry with author if needed
      let final = res;
      if (!res.ok && /author|user\.email|user\.name/i.test(res.output || '')) {
        final = RepoMode.runGit(ctx, [
          '-c',
          'user.email=chatre@local',
          '-c',
          'user.name=Chatre',
          'commit',
          '-m',
          msg,
        ]);
      }
      RepoMode.syncCollect(ctx);
      const st = RepoMode.repoStatus(ctx);
      if (final.ok) ctx.gitCommitted = true;
      ctx.git = ctx.git || {};
      ctx.git.initialized = true;
      ctx.git.branch = (st && st.branch) || ctx.git.branch;
      const snap = await persistWorkspace(ctx, {
        files: ctx.files,
        git: ctx.git,
        repo: ctx.repo,
      });
      return {
        ok: !!final.ok,
        tool,
        text: final.ok ? 'Committed: ' + msg : final.error || 'commit failed',
        hash: st && st.head,
        output: final.output,
        status: st,
        revision: snap.revision,
        error: final.ok ? null : final.error,
      };
    }
    ctx.git = ctx.git || {
      initialized: false,
      staged: [],
      commits: [],
      branch: 'main',
    };
    if (!ctx.git.initialized) return { ok: false, tool, error: 'Not a git repo' };
    if (!ctx.git.staged.length) return { ok: false, tool, error: 'Nothing staged' };
    const commit = {
      hash: 'c' + String(ctx.git.commits.length).padStart(7, '0'),
      message: p.message || '(no message)',
      files: [...ctx.git.staged],
      date: new Date().toISOString(),
    };
    ctx.git.commits.push(commit);
    ctx.git.staged = [];
    const snap = await persistWorkspace(ctx, { git: ctx.git });
    return {
      ok: true,
      tool,
      revision: snap.revision,
      text: 'Committed: ' + commit.message,
      hash: commit.hash,
    };
  }

  if (tool === 'git_status') {
    if (RepoMode.isRepoMode(ctx)) {
      const st = RepoMode.repoStatus(ctx);
      return {
        ok: !!st.ok,
        tool,
        output: st.text || JSON.stringify(st, null, 2),
        status: st,
        repo: ctx.repo,
        error: st.error || null,
      };
    }
    return { ok: true, tool, output: JSON.stringify(ctx.git || {}, null, 2) };
  }

  if (tool === 'git_log') {
    if (RepoMode.isRepoMode(ctx)) {
      const n = Math.min(Number(p.n || p.limit || 10) || 10, 50);
      const res = RepoMode.runGit(ctx, ['log', '-' + n, '--oneline']);
      return {
        ok: !!res.ok,
        tool,
        output: res.output || '(no commits)',
        error: res.ok ? null : res.error,
      };
    }
    const commits = ((ctx.git && ctx.git.commits) || []).slice().reverse();
    const lines = commits.map(
      (c) => c.hash + ' ' + c.message + ' (' + (c.date || '') + ')',
    );
    return {
      ok: true,
      tool,
      output: lines.join('\n') || '(no commits)',
      commits,
    };
  }

  if (tool === 'git_push') {
    if (RepoMode.isRepoMode(ctx)) {
      const remote = p.remote || 'origin';
      const branch = p.branch || (ctx.repo && ctx.repo.branch) || 'main';
      const res = RepoMode.runGit(ctx, ['push', '-u', remote, branch]);
      return {
        ok: !!res.ok,
        tool,
        text: res.ok
          ? 'Pushed to ' + remote + '/' + branch
          : res.error || 'push failed',
        output: res.output,
        error: res.ok ? null : res.error,
      };
    }
    ctx.git = ctx.git || {};
    ctx.git.remotes = ctx.git.remotes || {};
    const remote = p.remote || 'origin';
    const branch = p.branch || ctx.git.branch || 'main';
    ctx.git.remotes[remote] = {
      branch,
      tip: (ctx.git.commits || []).slice(-1)[0]?.hash || null,
      pushedAt: new Date().toISOString(),
      commitCount: (ctx.git.commits || []).length,
    };
    await persistWorkspace(ctx, { git: ctx.git });
    return { ok: true, tool, text: 'Pushed to ' + remote + '/' + branch };
  }

  if (tool === 'verify_project') {
    const resolved = resolveWorkspacePath(
      p.path || '/home/user',
      ctx.cwd,
    );
    const prefix = resolved.ok ? resolved.path : '/home/user';
    const files = Object.keys(ctx.files || {}).filter(
      (k) =>
        ctx.files[k] &&
        ctx.files[k].type === 'file' &&
        (k === prefix || k.startsWith(prefix + '/') || prefix === '/'),
    );
    const empty = files.filter(
      (k) => !String(ctx.files[k].content || '').trim(),
    );
    const hasReadme = files.some((k) => /readme/i.test(k));
    const ok = files.length > 0 && empty.length < files.length;
    return {
      ok,
      tool,
      fileCount: files.length,
      emptyFiles: empty.length,
      hasReadme,
      text: ok
        ? 'Found ' +
          files.length +
          ' files' +
          (hasReadme ? ' (includes README)' : ' (no README)') +
          (empty.length ? '; ' + empty.length + ' empty' : '')
        : 'No usable project files under ' + prefix,
    };
  }

  if (tool === 'preview_project') {
    return runPreviewProject(ctx, p);
  }

  return { ok: false, tool, error: 'Unsupported tool on remote API: ' + tool };
}

function assertActiveProjectLock(ctx, filePath) {
  if (!ctx || !ctx.lockActiveProject || !ctx.activeProject) return null;
  if (!isUnderProjects(filePath)) return null;
  const roots =
    Array.isArray(ctx.roots) && ctx.roots.length
      ? ctx.roots
      : [ctx.activeProject];
  const policy = OrgPolicy.loadOrgPolicy();
  if (OrgPolicy.allowsMultiRoot(policy) && roots.length > 1) {
    const ok = roots.some(function (slug) {
      const root = '/home/user/projects/' + slug;
      return (
        String(filePath) === root ||
        String(filePath).indexOf(root + '/') === 0
      );
    });
    if (ok) return null;
    return (
      'Workspace roots are locked to: ' +
      roots.join(', ') +
      '. Stay under those project paths.'
    );
  }
  const root = '/home/user/projects/' + ctx.activeProject;
  if (String(filePath) === root || String(filePath).indexOf(root + '/') === 0) {
    return null;
  }
  return (
    'Active project is locked to "' +
    ctx.activeProject +
    '". Stay under ' +
    root +
    '/ or clear the lock.'
  );
}

async function persistWorkspace(ctx, opts) {
  const o = opts || {};
  try {
    const result = await saveSnapshot(ctx.workspaceId, {
      files: o.files != null ? o.files : ctx.files,
      cwd: o.cwd != null ? o.cwd : ctx.cwd,
      git: o.git != null ? o.git : ctx.git,
      projects:
        o.projects != null
          ? o.projects
          : ctx.projects || detectProjects(ctx.files),
      activeProject:
        o.activeProject !== undefined
          ? o.activeProject
          : ctx.activeProject || null,
      repo: o.repo !== undefined ? o.repo : ctx.repo || null,
      lastTest: o.lastTest !== undefined ? o.lastTest : ctx.lastTest || null,
      testsOk: o.testsOk !== undefined ? o.testsOk : !!ctx.testsOk,
      lastDiagnostics:
        o.lastDiagnostics !== undefined
          ? o.lastDiagnostics
          : ctx.lastDiagnostics || null,
      runConfigs:
        o.runConfigs !== undefined ? o.runConfigs : ctx.runConfigs || null,
      lastPr: o.lastPr !== undefined ? o.lastPr : ctx.lastPr || null,
      lastCi: o.lastCi !== undefined ? o.lastCi : ctx.lastCi || null,
      ciOk: o.ciOk !== undefined ? o.ciOk : !!ctx.ciOk,
      roots: o.roots !== undefined ? o.roots : ctx.roots || null,
      expectedRevision: o.expectedRevision != null ? o.expectedRevision : ctx.revision,
      prune: !!o.prune,
      incremental: o.incremental !== false,
      baseFiles: o.baseFiles,
    });
    ctx.revision = result.revision;
    if (typeof ctx.emit === 'function') {
      ctx.emit({
        type: 'file_event',
        op: 'sync',
        revision: result.revision,
        changed: result.changed || [],
        deleted: result.deleted || [],
      });
      (result.changed || []).slice(0, 40).forEach((p) => {
        const f = ctx.files && ctx.files[p];
        if (!f) return;
        const payload = Sync.ssePayloadForFile(f, result.revision);
        if (payload) {
          ctx.emit({ type: 'file_event', op: 'put', file: payload, revision: result.revision });
        }
      });
      (result.deleted || []).slice(0, 40).forEach((p) => {
        ctx.emit({ type: 'file_event', op: 'delete', path: p, revision: result.revision });
      });
    }
    return result;
  } catch (e) {
    if (e && e.code === 'REVISION_CONFLICT') {
      // Soft-retry once without CAS after conflict
      const result = await saveSnapshot(ctx.workspaceId, {
        files: o.files != null ? o.files : ctx.files,
        cwd: ctx.cwd,
        git: ctx.git,
        projects: ctx.projects || detectProjects(ctx.files),
        activeProject: ctx.activeProject || null,
        repo: ctx.repo || null,
        lastTest: ctx.lastTest || null,
        testsOk: !!ctx.testsOk,
        lastDiagnostics: ctx.lastDiagnostics || null,
        runConfigs: ctx.runConfigs || null,
        lastPr: ctx.lastPr || null,
        lastCi: ctx.lastCi || null,
        ciOk: !!ctx.ciOk,
        roots: ctx.roots || null,
        prune: !!o.prune,
        incremental: true,
      });
      ctx.revision = result.revision;
      return result;
    }
    throw e;
  }
}

async function persistFilePut(ctx, file, opts) {
  const saved = await putFile(ctx.workspaceId, file, opts || {});
  const bumped = await bumpRevision(ctx.workspaceId, {
    expectedRevision: ctx.revision,
    cwd: ctx.cwd,
    git: ctx.git,
    projects: ctx.projects,
    activeProject: ctx.activeProject,
  }).catch(async (e) => {
    if (e && e.code === 'REVISION_CONFLICT') {
      return bumpRevision(ctx.workspaceId, {
        cwd: ctx.cwd,
        git: ctx.git,
        projects: ctx.projects,
        activeProject: ctx.activeProject,
      });
    }
    throw e;
  });
  ctx.revision = bumped.revision;
  if (typeof ctx.emit === 'function') {
    const payload = Sync.ssePayloadForFile(
      ctx.files[file.path] || file,
      bumped.revision,
    );
    ctx.emit({
      type: 'file_event',
      op: 'put',
      path: file.path,
      file: payload,
      revision: bumped.revision,
    });
  }
  return { saved, revision: bumped.revision };
}

async function persistCheckpoint(threadId, payload) {
  await saveAgentRun(threadId, {
    ...payload,
    updatedAt: new Date().toISOString(),
  });
}

async function finishRun({
  threadId,
  model,
  full,
  usage,
  toolsUsed,
  steps,
  emit,
  status,
  ctx,
  runLog,
  stopReason,
}) {
  const finalUsage = { ...usage, toolsUsed, steps };
  const earlyFail =
    status === 'failed' ||
    stopReason === 'consecutive_tool_failures' ||
    stopReason === 'no_delivery_progress' ||
    (ctx && ctx._earlyStopReason);
  let proof = null;
  if ((status === 'done' || status === 'failed') && ctx) {
    proof = Delivery.buildDoneProof(ctx, {
      previewUrl:
        (ctx.blackboard && ctx.blackboard.lastPreviewPath) ||
        null,
      stopReason: stopReason || (ctx && ctx._earlyStopReason) || null,
      forceFail: !!earlyFail,
    });
    finalUsage.proof = proof;
    finalUsage.spend = ctx.spendTracker ? ctx.spendTracker.snapshot() : undefined;
  }
  if (status === 'done' || status === 'failed') {
    const audit =
      runLog
        ? exportAudit(runLog, {
            threadId,
            workspaceId: ctx && ctx.workspaceId,
            userId: ctx && ctx.userId,
            proof,
          })
        : null;
    await appendMessage(threadId, {
      role: 'assistant',
      content: full,
      meta: redactValue({ usage: finalUsage, proof, status }),
    });
    await recordUsage(threadId, finalUsage, model);
    await saveAgentRun(threadId, {
      status: status === 'failed' ? 'failed' : 'done',
      runId: usage.runId,
      step: steps,
      proof,
      auditSummary: audit && audit.summary,
      audit,
      lastUnderstanding: (ctx && ctx.lastUnderstanding) || null,
      understandingSummary: (ctx && ctx.understandingSummary) || null,
      updatedAt: new Date().toISOString(),
    });
    safeEmit(emit, {
      type: 'done',
      response: full,
      steps,
      usage: finalUsage,
      proof,
      status: status === 'failed' ? 'failed' : 'done',
      audit: audit
        ? { summary: audit.summary, schema: audit.schema, exportedAt: audit.exportedAt }
        : undefined,
    });
  }
  return { response: full, steps, usage: finalUsage, status, proof };
}


async function runCriticPass({
  userMessage,
  briefing,
  answer,
  toolSummary,
  model,
  userId,
  emit,
  ctx,
}) {
  const light =
    !briefing ||
    briefing.task_type === 'chat' ||
    (briefing.task_type === 'question' &&
      !(briefing.success_criteria && briefing.success_criteria.length));
  if (light) {
    return { pass: true, score: 100, gaps: [], fix_brief: '', role: 'skip' };
  }

  const verifyC = verifyRoleCritique(ctx, briefing.task_type);
  emit &&
    emit({
      type: 'critique',
      critique: Object.assign({}, verifyC, { phase: 'verify' }),
    });

  let planText = '';
  if (ctx && ctx.planPath && ctx.files && ctx.files[ctx.planPath]) {
    planText = String(ctx.files[ctx.planPath].content || '');
  } else if (ctx && ctx.files) {
    const found = PlanArtifact.findExistingPlan(ctx.files);
    if (found) planText = found.content;
  }
  const blackboardText = Blackboard.formatForPrompt(
    (ctx && ctx.blackboard) || null,
    2500,
  );

  let planC = { pass: true, score: 100, gaps: [], fix_brief: '', role: 'plan' };
  try {
    emit && emit({ type: 'phase', phase: 'critique', text: 'Checking plan adherence…' });
    const data = await chatWorker({
      messages: [
        { role: 'system', content: CRITIC_PROMPT },
        {
          role: 'user',
          content: criticUserPrompt({
            userMessage,
            briefing,
            answer,
            toolSummary,
            planText,
            blackboardText,
          }),
        },
      ],
      model,
      userId,
      maxTokens: TOKEN_BUDGETS.critic,
      stream: false,
      agent: false,
      mode: 'critic',
    });
    const raw =
      typeof data === 'string'
        ? data
        : (data && (data.response || data.text)) || '';
    planC = normalizeCritique(extractCritiqueJson(raw));
    planC.role = 'plan';
  } catch (err) {
    // Fail closed — never ship on critic outage for delivery tasks.
    planC = {
      pass: false,
      score: 0,
      gaps: [
        'critic unavailable: ' +
          (err instanceof Error ? err.message : String(err)),
      ],
      fix_brief:
        'Re-check delivery against the user request and plan Done when. Fix gaps with tools, then stop.',
      role: 'plan',
    };
  }

  return mergeCritiques(verifyC, planC);
}

async function runAgentLoop({
  threadId,
  workspaceId,
  userMessage: userMessageRaw,
  history,
  model,
  userId,
  maxIterations,
  emit,
  resume,
  budgetMs,
  approvePlan,
  briefingOverride,
  briefingSeed,
  skipPlanApproval,
  autonomy: autonomyOpt,
  approvedTools: approvedToolsOpt,
  autoResumeCount: autoResumeCountOpt,
  agentName: agentNameOpt,
  composerMode: composerModeOpt,
  thoroughness: thoroughnessOpt,
  customAgents: customAgentsOpt,
  activeFile: activeFileOpt,
  openFiles: openFilesOpt,
}) {
  const autonomy = normalizeAutonomy(autonomyOpt || 'assist');
  const customAgents = Array.isArray(customAgentsOpt) ? customAgentsOpt : [];
  const thoroughness = thoroughnessOpt || 'medium';
  const composerMode = String(composerModeOpt || '').toLowerCase();
  // Expand short follow-ups ("in the workspace", "you recommend") using prior asks.
  let userMessage = Understanding.expandFollowUpMessage(
    userMessageRaw,
    Array.isArray(history) ? history : [],
  );
  const approvedTools = new Set(
    Array.isArray(approvedToolsOpt)
      ? approvedToolsOpt
      : approvedToolsOpt instanceof Set
        ? [...approvedToolsOpt]
        : [],
  );
  // Assist/autopilot: session-tier pre-approved unless Ask.
  // Approving a plan also grants session tools for this run (even in Ask).
  if (autonomy === 'assist' || autonomy === 'autopilot' || approvePlan === true) {
    approvedTools.add('session');
  }

  const meta = await getWorkspace(workspaceId);
  const files = (await listFiles(workspaceId)) || {};
  const detected = detectProjects(files);
  const ctx = {
    workspaceId,
    threadId,
    userId: userId || null,
    files,
    revision: Number((meta && meta.revision) || 0),
    lockActiveProject: false,
    cwd: (meta && meta.cwd) || '/home/user',
    git:
      (meta && meta.git) || {
        initialized: false,
        branch: 'main',
        staged: [],
        commits: [],
      },
    repo: (meta && meta.repo) || null,
    testsOk: !!(meta && meta.testsOk),
    lastTest: (meta && meta.lastTest) || null,
    lastDiagnostics: (meta && meta.lastDiagnostics) || null,
    runConfigs: (meta && meta.runConfigs) || null,
    lastPr: (meta && meta.lastPr) || null,
    lastCi: (meta && meta.lastCi) || null,
    ciOk: !!(meta && meta.ciOk),
    roots:
      (meta && Array.isArray(meta.roots) && meta.roots.length
        ? meta.roots
        : Object.keys(detected)) || [],
    activeFile: null,
    openFiles: [],
    orgPolicy: OrgPolicy.loadOrgPolicy(),
    projects: Object.assign({}, detected),
    activeProject: (function () {
      const metaActive = meta && meta.activeProject;
      if (metaActive && detected[metaActive]) return metaActive;
      const keys = Object.keys(detected);
      if (keys.length === 1) return keys[0];
      return null;
    })(),
    todos: emptyTodos(),
    browserSessionId: '',
    lastTabId: null,
    lastBrowserUrl: '',
    taskType: 'mixed',
    briefing: null,
    emit,
    shellMode: resolveMode(
      (briefingOverride && briefingOverride.shell_mode) || 'workspace',
    ),
    shellApproved: autonomy !== 'ask',
    activeShellId: null,
    shellAbort: null,
    autonomy,
    approvedTools,
    filesTouched: [],
    lastFailures: [],
    consecutiveFails: 0,
    stepsWithoutSuccess: 0,
    deliverySuccess: false,
    verifiedAny: false,
    previewOk: false,
    previewFailed: false,
    gitCommitted: false,
    doneWhen: '',
    agentInfo: null,
    permissionRuleset: Permission.defaultRuleset(),
    customAgents,
    thoroughness,
    composerMode,
    model: model || null,
    blackboard: null,
    planPath: null,
    planApproved: false,
    requirePlan: false,
  };

  if (activeFileOpt) {
    ctx.activeFile = String(activeFileOpt);
  }
  if (Array.isArray(openFilesOpt) && openFilesOpt.length) {
    ctx.openFiles = openFilesOpt.map(String).slice(0, 16);
  } else if (ctx.activeFile) {
    ctx.openFiles = [ctx.activeFile];
  }

  // Resolve named agent (build/plan/explore/custom) — plan mode hard-deny edits
  ctx.agentInfo = Agents.resolveAgent({
    agentName: agentNameOpt,
    composerMode,
    taskType: 'mixed',
    customAgents,
  });
  ctx.permissionRuleset = (ctx.agentInfo && ctx.agentInfo.permission) || Permission.defaultRuleset();
  ctx.blackboard = Blackboard.createBlackboard({
    goal: '',
    todos: [],
  });
  emit({
    type: 'agent',
    name: ctx.agentInfo.name,
    mode: ctx.agentInfo.mode,
    description: ctx.agentInfo.description || '',
    native: !!ctx.agentInfo.native,
  });

  if (ctx.activeProject && !slugFromPath(ctx.cwd)) {
    ctx.cwd = '/home/user/projects/' + ctx.activeProject;
  }
  if (ctx.activeProject) {
    ctx.lockActiveProject = true;
    const ensured = ensureProject(ctx, ctx.activeProject, {
      goal: (ctx.briefing && ctx.briefing.goal) || '',
      setCwd: true,
    });
    if (ensured && ensured.agentsCreated && ctx.files[ensured.agentsMd]) {
      try {
        await persistFilePut(ctx, ctx.files[ensured.agentsMd], { allowEmpty: true });
        if (ctx.files[ensured.root]) {
          await persistFilePut(ctx, ctx.files[ensured.root], { allowEmpty: true });
        }
      } catch (e) {
        console.warn('ensure AGENTS.md persist failed', e && e.message);
      }
    }
  }

  ctx.spendTracker = ModelRouting.createSpendTracker({});
  const rawEmit = emit;
  emit = function (ev) {
    safeEmit(rawEmit, ev);
  };
  ctx.emit = emit;

  const thr = await getThread(threadId);
  const existingRun = thr && thr.agentRun;
  // User answered a clarify/ask_user_input pause — resume with their choice.
  const clarifyAnswerResume =
    !!(
      existingRun &&
      existingRun.status === 'awaiting_clarify' &&
      userMessage
    );
  const isResume =
    resume === true ||
    approvePlan === true ||
    clarifyAnswerResume ||
    (resume !== false &&
      existingRun &&
      (existingRun.status === 'interrupted' ||
        existingRun.status === 'awaiting_plan' ||
        existingRun.status === 'awaiting_login' ||
        existingRun.status === 'awaiting_approval' ||
        existingRun.status === 'awaiting_shell' ||
        existingRun.status === 'awaiting_clarify') &&
      !userMessage);

  const startedAt = Date.now();
  let budget = budgetMs || DEFAULT_BUDGET_MS;
  const runId =
    (isResume && existingRun && existingRun.runId) || newId('run');
  let iterations = maxIterations || 25;
  const runLog = createRunLog(runId);
  let autoResumeCount =
    Number(autoResumeCountOpt) ||
    (existingRun && existingRun.autoResumeCount) ||
    0;
  let criticRepaired = Number(existingRun && existingRun.criticRepaired) || 0;
  let verifyRepaired = Number(existingRun && existingRun.verifyRepaired) || 0;
  if (Array.isArray(existingRun && existingRun.approvedTools)) {
    existingRun.approvedTools.forEach((t) => approvedTools.add(t));
    ctx.approvedTools = approvedTools;
  }
  if (Array.isArray(existingRun && existingRun.filesTouched)) {
    ctx.filesTouched = existingRun.filesTouched.slice();
  }
  if (Array.isArray(existingRun && existingRun.lastFailures)) {
    ctx.lastFailures = existingRun.lastFailures.slice();
  }
  if (existingRun && existingRun.blackboard) {
    ctx.blackboard = Blackboard.createBlackboard(existingRun.blackboard);
    Blackboard.applyToCtx(ctx.blackboard, ctx);
  }
  if (existingRun && existingRun.planPath) ctx.planPath = existingRun.planPath;
  if (existingRun && existingRun.planApproved) ctx.planApproved = true;
  if (existingRun && existingRun.requirePlan) ctx.requirePlan = true;
  logEvent(runLog, 'start', {
    threadId,
    resume: !!isResume,
    autonomy,
  });
  emit({
    type: 'autonomy',
    level: autonomy,
    autoResumeCount,
  });

  let messages;
  let full = '';
  let toolsUsed = 0;
  let startStep = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let workflow = {
    explored: false,
    planned: false,
    implemented: false,
    fileDelivered: false,
    ranAction: false,
    verified: false,
  };
  let toolSummaryParts = [];
  let lastMonitorAt = 0;

  if (isResume && existingRun && Array.isArray(existingRun.messages)) {
    messages = scrubSteerNoise(
      existingRun.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    );
    full = existingRun.fullText || '';
    toolsUsed = existingRun.toolsUsed || 0;
    startStep = existingRun.step || 0;
    promptTokens = (existingRun.usage && existingRun.usage.promptTokensEst) || 0;
    completionTokens =
      (existingRun.usage && existingRun.usage.completionTokensEst) || 0;
    if (Array.isArray(existingRun.todos)) ctx.todos = existingRun.todos;
    if (existingRun.workflow) workflow = { ...workflow, ...existingRun.workflow };
    if (existingRun.briefing) {
      ctx.briefing = existingRun.briefing;
      ctx.taskType = existingRun.briefing.task_type || 'mixed';
    }
    if (briefingOverride && typeof briefingOverride === 'object') {
      const um = existingRun.userMessage || userMessage || '';
      ctx.briefing = enrichBriefing(
        normalizeBriefing(briefingOverride, um, {
          corrections: Understanding.asStringList(
            briefingOverride.user_corrections || briefingOverride.userCorrections,
          ),
          composerMode: ctx.composerMode,
          approvePlan: true,
          skipGate: true,
        }),
        um,
      );
      ctx.briefing.intent_contract = Understanding.formatIntentContract(ctx.briefing);
      ctx.taskType = ctx.briefing.task_type;
    }

    // Explicit Approve only — Resume alone must not execute a pending plan.
    const doPlanHandoff = approvePlan === true;

    if (
      !doPlanHandoff &&
      existingRun.status === 'awaiting_plan' &&
      ctx.briefing
    ) {
      const um = existingRun.userMessage || userMessage || '';
      const plan = PlanArtifact.ensureFromBriefing(ctx, ctx.briefing, um, {
        reuseOk: true,
      });
      const parsed = (plan && plan.parsed) || PlanArtifact.parsePlanArtifact(plan && plan.content);
      await persistCheckpoint(threadId, {
        status: 'awaiting_plan',
        runId,
        step: startStep,
        maxSteps: iterations,
        messages: checkpointMessages(messages),
        fullText: full,
        toolsUsed,
        todos: ctx.todos || (ctx.briefing && ctx.briefing.todos) || [],
        briefing: ctx.briefing,
        userMessage: um,
        workflow,
        autonomy,
        planPath: plan && plan.path,
        requirePlan: true,
        planApproved: false,
        blackboard: Blackboard.serialize(ctx.blackboard),
        model: model || (thr && thr.model) || 'default',
      });
      emit({
        type: 'awaiting_plan',
        runId,
        briefing: ctx.briefing,
        resume: true,
        autonomy,
        planPath: plan && plan.path,
        planMarkdown: plan && plan.content,
        planComplete: !!(parsed && parsed.complete),
        planErrors: (parsed && parsed.errors) || [],
        reason: 'Resume requires Approve & continue on the plan card',
      });
      logEvent(runLog, 'awaiting_plan_rerequest', {
        reason: 'resume_without_approve',
      });
      return {
        response: '',
        steps: startStep,
        usage: { runId },
        status: 'awaiting_plan',
        runId,
        briefing: ctx.briefing,
        planPath: plan && plan.path,
      };
    }

    if (doPlanHandoff && ctx.briefing) {
      const um = existingRun.userMessage || userMessage || '';
      ctx.briefing = enrichBriefing(ctx.briefing, um);
      ctx.taskType = ctx.briefing.task_type || ctx.taskType;
      // Forced plan → build handoff: always rewrite PLAN.md from approved briefing.
      const buildAgent =
        Agents.getNative('build') ||
        Agents.resolveAgent({
          agentName: 'build',
          customAgents: ctx.customAgents || [],
        });
      ctx.agentInfo = buildAgent;
      ctx.permissionRuleset =
        (buildAgent && buildAgent.permission) || Permission.defaultRuleset();
      ctx.composerMode = 'agent';
      ctx.requirePlan = true;
      // Ensure briefing carries enough structure for PLAN.md before rewrite.
      if (!ctx.briefing.done_when && Array.isArray(ctx.briefing.success_criteria) && ctx.briefing.success_criteria[0]) {
        ctx.briefing.done_when = String(ctx.briefing.success_criteria[0]);
      }
      if (!Array.isArray(ctx.briefing.files) || !ctx.briefing.files.length) {
        const target = resolveProjectTarget(
          um,
          ctx.briefing.goal,
          ctx.briefing,
        );
        const slug =
          ctx.activeProject ||
          target.slug ||
          String(ctx.briefing.task_type || 'app')
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 32) ||
          'app';
        ctx.briefing.files =
          String(ctx.briefing.task_type || '') === 'document'
            ? ['/home/user/documents/']
            : [
                target.absoluteFile ||
                  '/home/user/projects/' + slug + '/',
              ];
      }
      if (
        (!Array.isArray(ctx.briefing.approach) || ctx.briefing.approach.length < 2) &&
        Array.isArray(ctx.briefing.todos) &&
        ctx.briefing.todos.length
      ) {
        ctx.briefing.approach = ctx.briefing.todos.map((x) =>
          typeof x === 'string' ? x : x.content || '',
        ).filter(Boolean);
      }
      let plan = PlanArtifact.rewriteFromBriefing(ctx, ctx.briefing, um);
      let parsed =
        (plan && plan.parsed) ||
        PlanArtifact.parsePlanArtifact(plan && plan.content);
      if (!parsed || !parsed.complete) {
        // Last-chance fill from parsed gaps then rewrite once.
        const fields = PlanArtifact.briefingToPlanFields(ctx.briefing, um, ctx);
        if (!fields.doneWhen || Understanding.isSoftDoneWhen(fields.doneWhen)) {
          fields.doneWhen =
            (ctx.briefing.done_when && !Understanding.isSoftDoneWhen(ctx.briefing.done_when)
              ? ctx.briefing.done_when
              : '') ||
            (Array.isArray(ctx.briefing.acceptance_tests) && ctx.briefing.acceptance_tests[0]) ||
            (Array.isArray(ctx.briefing.success_criteria) && ctx.briefing.success_criteria[0]) ||
            Understanding.formatIntentContract(ctx.briefing).split('\n').find((l) => l.startsWith('Done when:')) ||
            'Observable acceptance checks from the approved intent contract pass';
          if (String(fields.doneWhen).startsWith('Done when:')) {
            fields.doneWhen = String(fields.doneWhen).replace(/^Done when:\s*/, '');
          }
        }
        if (!fields.files || !fields.files.length) {
          fields.files = ctx.briefing.files || ['/home/user/projects/app/'];
        }
        if (!fields.acceptance || !fields.acceptance.length) {
          fields.acceptance = ctx.briefing.success_criteria || ctx.briefing.acceptance_tests || [fields.doneWhen];
        }
        if (!fields.steps || fields.steps.length < 2) {
          fields.steps = (ctx.briefing.approach || []).filter(Boolean);
          while (fields.steps.length < 2) {
            fields.steps.push(
              fields.steps.length
                ? (ctx.briefing.done_when && !Understanding.isSoftDoneWhen(ctx.briefing.done_when)
                    ? 'Verify: ' + String(ctx.briefing.done_when).slice(0, 120)
                    : 'Verify acceptance tests from the intent contract')
                : (ctx.briefing.goal
                    ? 'Implement: ' + String(ctx.briefing.goal).slice(0, 120)
                    : 'Implement the approved goal'),
            );
          }
        }
        plan = PlanArtifact.writePlanToFiles(
          ctx,
          Object.assign({}, fields, { goal: fields.goal || ctx.briefing.goal || um }),
          (plan && plan.path) || ctx.planPath,
        );
        parsed = plan.parsed || PlanArtifact.parsePlanArtifact(plan.content);
      }
      if (!parsed || !parsed.complete) {
        ctx.planApproved = false;
        await persistCheckpoint(threadId, {
          status: 'awaiting_plan',
          runId,
          step: startStep,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed,
          todos: ctx.briefing.todos || ctx.todos || [],
          briefing: ctx.briefing,
          userMessage: um,
          workflow,
          autonomy,
          planPath: plan && plan.path,
          requirePlan: true,
          planApproved: false,
          blackboard: Blackboard.serialize(ctx.blackboard),
          model: model || (thr && thr.model) || 'default',
        });
        emit({
          type: 'awaiting_plan',
          runId,
          briefing: ctx.briefing,
          resume: true,
          autonomy,
          planPath: plan && plan.path,
          planMarkdown: plan && plan.content,
          planComplete: false,
          planErrors: (parsed && parsed.errors) || [
            'Plan structure incomplete',
          ],
          reason: 'Plan must include Goal, Done when, Steps, Files, and Acceptance before build',
        });
        return {
          response: '',
          steps: startStep,
          usage: { runId },
          status: 'awaiting_plan',
          runId,
          briefing: ctx.briefing,
          planPath: plan && plan.path,
        };
      }
      ctx.planApproved = true;
      if (plan && plan.path && workspaceId) {
        try {
          await persistFilePut(ctx, ctx.files[plan.path], { allowEmpty: true });
        } catch {
          /* best-effort */
        }
      }
      ctx.blackboard = Blackboard.createBlackboard({
        goal: ctx.briefing.goal,
        doneWhen: ctx.briefing.done_when || ctx.doneWhen,
        planPath: plan.path,
        planApproved: true,
        requirePlan: true,
        todos: ctx.briefing.todos || ctx.todos,
        filesTouched: ctx.filesTouched,
      });
      Blackboard.recordHandoff(
        ctx.blackboard,
        'plan',
        'build',
        'User approved plan; execute artifact ' + plan.path,
      );
      TeamPipeline.setPhase(
        ctx.blackboard,
        'execute',
        'plan approved → execute',
      );
      emit(
        TeamPipeline.phaseEvent(
          'execute',
          'Execute — plan approved, building in workspace',
        ),
      );
      Blackboard.applyToCtx(ctx.blackboard, ctx);
      emit({
        type: 'agent',
        name: 'build',
        mode: 'primary',
        description: 'Orchestrator after plan approval',
        native: true,
        handoff: 'plan→build',
      });
      emit({
        type: 'plan_handoff',
        path: plan.path,
        approved: true,
        complete: true,
      });
      messages.push({
        role: 'user',
        content: PlanArtifact.handoffPrompt(
          plan,
          TeamPipeline.formatTeamPrompt(ctx.blackboard) +
            '\n\n' +
            Blackboard.formatForPrompt(ctx.blackboard),
        ),
      });
      // Seed runtime context the fresh path gets (doneWhen, acceptance, budgets, executor brief).
      {
        const b = ctx.briefing;
        const um = existingRun.userMessage || userMessage || '';
        ctx.doneWhen =
          b.done_when || deriveDoneWhen(b, um, b.task_type || ctx.taskType);
        if (!b.acceptance_tests || !b.acceptance_tests.length) {
          const seededAcc = Delivery.defaultAcceptanceForTask(
            b.task_type,
            b.goal,
            ctx,
          );
          const fromCriteria = Array.isArray(b.success_criteria)
            ? b.success_criteria
            : [];
          b.acceptance_tests = fromCriteria.length ? fromCriteria : seededAcc;
        }
        ctx.acceptanceTests = Delivery.normalizeAcceptanceTests(
          b.acceptance_tests,
        );
        const caps = budgetsForTaskType(b.task_type, b.max_steps, budgetMs);
        iterations = Math.max(
          iterations,
          Math.min(
            caps.maxSteps,
            smartMaxSteps(b.task_type, b.max_steps || caps.maxSteps),
          ),
        );
        budget = Math.max(budget, caps.budgetMs);
        const skillNames = composeActiveSkills(
          detectSkills(um),
          b.task_type,
          um,
        );
        const skillLines = skillCatalogBrief(skillNames, 2200);
        const designExtra = designTemplateBlock(um);
        const bias = taskTypeBiasFor(ctx.agentInfo, b.task_type);
        const inv = workspaceInventory(ctx.files, {
          activeProject: ctx.activeProject,
        });
        messages.push({
          role: 'user',
          content:
            '# Named agent: build (post-plan execute)\n' +
            Agents.agentSystemExtra(ctx.agentInfo, {
              thoroughness: ctx.thoroughness,
              taskTypeBias: bias,
            }) +
            (skillLines ? '\n\n' + skillLines : '') +
            (designExtra || '') +
            '\n\n# Playbook\n' +
            playbookForTaskType(b.task_type) +
            '\n' +
            workspacePlaybookExtra(b.task_type) +
            '\n\n' +
            formatExecutorPrompt(b, um) +
            '\n\n' +
            TeamPipeline.formatTeamPrompt(ctx.blackboard) +
            '\n\n' +
            Blackboard.formatForPrompt(ctx.blackboard) +
            '\n\n' +
            inv.text +
            '\n\nExecute the approved plan now. Deliver real workspace artifacts, verify (preview_project / open the file), meet acceptance tests, then stop. Do not dump tutorials in chat.',
        });
        emit({
          type: 'budget',
          maxSteps: iterations,
          budgetMs: budget,
          remainingSteps: iterations - startStep,
          task_type: b.task_type,
          done_when: ctx.doneWhen,
        });
      }
    } else if (briefingOverride && typeof briefingOverride === 'object') {
      const um = existingRun.userMessage || userMessage || '';
      messages.push({
        role: 'user',
        content: formatExecutorPrompt(ctx.briefing, um),
      });
    } else if (
      existingRun.status === 'awaiting_clarify' &&
      userMessage
    ) {
      messages.push({
        role: 'user',
        content:
          'User answered the clarification:\n' +
          String(userMessage) +
          '\n\nContinue the task with this choice. Do not re-ask the same question.',
      });
      await appendMessage(threadId, { role: 'user', content: userMessage });
    }
    if (ctx.briefing && ctx.briefing.max_steps) {
      iterations = Math.min(
        iterations,
        Number(ctx.briefing.max_steps) || iterations,
      );
    }
    if (
      existingRun.status === 'awaiting_plan' &&
      ctx.briefing
    ) {
      if (ctx.briefing.todos && ctx.briefing.todos.length) {
        ctx.todos = ctx.briefing.todos;
        emit({ type: 'todos', todos: ctx.todos });
      }
      const role = subagentPrompt(ctx.briefing.task_type);
      emit({ type: 'subagent', role: role.name, label: role.label });
      // Clear HTML/app builds should write files on approve, not only prompt the LLM.
      if (
        shouldBuildFastPath(
          ctx.briefing,
          existingRun.userMessage || userMessage || '',
        ) &&
        !(
          ctx.agentInfo &&
          (ctx.agentInfo.name === 'plan' || ctx.agentInfo.name === 'explore')
        )
      ) {
        ctx._forceBuildFastPath = true;
      }
    }
    if (Array.isArray(existingRun.toolSummaryParts)) {
      toolSummaryParts = existingRun.toolSummaryParts;
    }
    emit({
      type: 'resume',
      runId,
      step: startStep,
      max: iterations,
    });
    logEvent(runLog, 'resume', { step: startStep });

    if (ctx._forceBuildFastPath && ctx.briefing) {
      const um = existingRun.userMessage || userMessage || '';
      const briefingR = ctx.briefing;
      emit({
        type: 'phase',
        phase: 'execute',
        text: 'Generating project files…',
      });
      const target = resolveProjectTarget(um, briefingR.goal, briefingR);
      const slug = target.slug;
      const minimalBuild = isMinimalPageRequest(um, briefingR.goal);
      let parsed = scaffoldHtmlProject(slug, um, briefingR.goal, {
        minimal: minimalBuild,
        relativePath: target.relativePath || 'index.html',
      });
      if (parsed && parsed.files) {
        parsed.files = constrainFilesToRequest(
          parsed.files,
          target,
          minimalBuild,
        );
      }
      const root = target.root || '/home/user/projects/' + slug;
      if (minimalBuild) ctx.skipAgentsMd = true;
      ensureProject(ctx, slug, {
        goal: briefingR.goal || um,
        stack: minimalBuild ? 'html' : 'html,css,js',
        agentsMd: minimalBuild ? false : undefined,
      });
      const written = [];
      if (parsed && parsed.files && parsed.files.length) {
        await executeRemoteTool(
          {
            tool: 'create_directory',
            params: { path: root },
            id: 'fast_mkdir_resume',
          },
          ctx,
        );
        for (let fi = 0; fi < parsed.files.length; fi++) {
          const f = parsed.files[fi];
          const path =
            f.relativePath.indexOf('/home/user/') === 0
              ? f.relativePath
              : root + '/' + f.relativePath.replace(/^\/+/, '');
          emit({
            type: 'tool_start',
            tool: 'write_file',
            params: { path: path, content: '(full file)' },
            id: 'fast_write_resume_' + fi,
          });
          const result = await executeRemoteTool(
            {
              tool: 'write_file',
              params: { path: path, content: f.content },
              id: 'fast_write_resume_' + fi,
            },
            ctx,
          );
          toolsUsed += 1;
          if (result && result.ok) {
            written.push(path);
            if (result.path) ctx.filesTouched.push(result.path);
            ctx.deliverySuccess = true;
            workflow = recordToolPhase(workflow, 'write_file');
          }
          emit({
            type: 'tool_result',
            tool: 'write_file',
            id: 'fast_write_resume_' + fi,
            result: shrinkToolResult(result),
          });
        }
      }
      if (ctx.deliverySuccess && written.length) {
        const previewResult = runPreviewProject(ctx, { path: root });
        toolsUsed += 1;
        workflow = recordToolPhase(workflow, 'preview_project');
        if (previewResult && previewResult.ok) {
          ctx.previewOk = true;
          ctx.verifiedAny = true;
          workflow.verified = true;
        }
        if (previewResult && previewResult.preview) {
          emit({
            type: 'preview',
            preview: previewResult.preview,
            errors: previewResult.errors || [],
            warnings: previewResult.warnings || [],
            ok: !!previewResult.ok,
            path: previewResult.path,
            localhost: previewResult.localhost,
            port: previewResult.port,
          });
        }
        const answer =
          '<answer>\nCreated **' +
          slug +
          '** in your workspace:\n\n' +
          written.map((p) => '- `' + p + '`').join('\n') +
          (previewResult && previewResult.ok
            ? '\n\nLive preview: `' +
              (previewResult.localhost || 'http://localhost') +
              '`.\n'
            : '\n') +
          '</answer>';
        full += (full ? '\n\n' : '') + cleanText(answer);
        emit({ type: 'text', text: cleanText(answer), final: true });
        return finishRun({
          threadId,
          model,
          full: cleanText(answer),
          usage: { runId, model },
          toolsUsed,
          steps: startStep + 1,
          emit,
          status: 'done',
          ctx,
          runLog,
        });
      }
    }
  } else {
    messages = scrubSteerNoise(
      (history || [])
        .filter((m) => m && m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
    );

    messages.push({ role: 'user', content: userMessage });
    await appendMessage(threadId, { role: 'user', content: userMessage });
    try {
      const title = await generateThreadTitle({
        userMessage,
        model,
        userId,
      });
      if (title) {
        await updateThread(threadId, { title: title.slice(0, 80) });
        emit({ type: 'thread_title', title: title.slice(0, 80) });
      }
    } catch (e) {
      /* non-fatal */
    }

    const autoSkillsAll = detectSkills(userMessage);
    const autoSkills = composeActiveSkills(autoSkillsAll, null, userMessage);
    emit({ type: 'skills', skills: autoSkills });

    const inventory = workspaceInventory(ctx.files, {
      activeProject: ctx.activeProject,
    });
    emit({
      type: 'workspace',
      fileCount: inventory.fileCount,
      paths: inventory.paths.slice(0, 24),
      projects: inventory.projects || [],
      activeProject: ctx.activeProject || null,
    });

    // ── Analyst phase: understand THIS request and brief the executor ──
    let existingThread = null;
    try {
      existingThread = await getThread(threadId);
    } catch (e) {
      existingThread = null;
    }
    const threadCorrections = Understanding.asStringList(
      []
        .concat(
          (briefingSeed &&
            (briefingSeed.user_corrections || briefingSeed.userCorrections)) ||
            [],
          (ctx.blackboard && ctx.blackboard.userCorrections) || [],
        )
        .concat(
          Understanding.detectCorrectionMessage(userMessage)
            ? [Understanding.detectCorrectionMessage(userMessage)]
            : [],
        )
        .concat((existingThread && existingThread.durableCorrections) || []),
    );
    const clarifyFeedback =
      UnderstandingLog.detectClarifyFeedback(userMessage) ||
      (Understanding.detectCorrectionMessage(userMessage) &&
      existingThread &&
      existingThread.lastUnderstanding &&
      !existingThread.lastUnderstanding.clarifyAsked
        ? {
            kind: 'under_clarify',
            neededClarify: true,
            text: String(userMessage || '').slice(0, 200),
          }
        : null);
    if (Understanding.detectCorrectionMessage(userMessage) || threadCorrections.length) {
      try {
        await mergeDurableCorrections(threadId, threadCorrections);
      } catch (e) {
        console.warn('durable corrections failed', e && e.message);
      }
    }

    emit({ type: 'phase', phase: 'analyze', text: 'Analyzing request…' });
    let briefing = null;
    const preRoute = Understanding.preLlmRoute(userMessage);
    if (preRoute && preRoute.skipAnalyst) {
      briefing = normalizeBriefing(
        {
          understanding: 'Greeting / short chat.',
          goal: String(userMessage || '').slice(0, 120),
          task_type: preRoute.task_type || 'chat',
          deliverable_kind: preRoute.deliverable_kind || 'answer',
          confidence: preRoute.confidence || 0.95,
          needs_clarification: false,
          clarification_question: '',
          suggested_mode: preRoute.suggested_mode || 'chat',
          mode_reason: preRoute.reason || 'short greeting',
          success_criteria: [],
          done_when: 'Friendly reply delivered',
          files: [],
          approach: [],
          todos: [],
          tools_priority: [],
          do_not: ['Do not create workspace files for a greeting'],
          constraints: [],
          executor_brief: 'Reply briefly and warmly. No tools.',
          max_steps: 1,
        },
        userMessage,
        {
          corrections: threadCorrections,
          composerMode,
        },
      );
    } else {
      try {
        const analysis = await chatWorker({
          messages: [
            { role: 'system', content: ANALYST_SYSTEM_PROMPT },
            {
              role: 'user',
              content: analystUserPrompt(
                userMessage,
                historySnippet(messages.slice(0, -1)),
                {
                  corrections: threadCorrections,
                  composerMode,
                },
              ),
            },
          ],
          model,
          userId,
          maxTokens: TOKEN_BUDGETS.analyst,
          stream: false,
          agent: false,
          mode: 'analyst',
        });
        const analysisText =
          typeof analysis === 'string'
            ? analysis
            : (analysis && (analysis.response || analysis.text)) || '';
        briefing = normalizeBriefing(extractJsonObject(analysisText), userMessage, {
          corrections: threadCorrections,
          composerMode,
        });
      } catch (err) {
        emit({
          type: 'phase',
          phase: 'analyze_error',
          text: err instanceof Error ? err.message : String(err),
        });
        briefing = normalizeBriefing(null, userMessage, {
          corrections: threadCorrections,
          composerMode,
        });
        briefing.understanding = 'Fallback: execute the user request directly.';
        briefing.task_type = autoSkills.length ? 'mixed' : 'question';
        briefing.executor_brief =
          'Complete the user request thoroughly using whatever tools fit. ' +
          'Do not follow a generic template — match the work to the request.';
      }
    }

    // Seed empty/partial analyst output from starter template + plan templates
    // so the approval UI is never a blank form.
    if (briefingSeed && typeof briefingSeed === 'object') {
      const seeded = briefingSeed;
      briefing = Object.assign({}, seeded, briefing, {
        understanding:
          String(briefing.understanding || '').trim() || seeded.understanding,
        goal: String(briefing.goal || '').trim() || seeded.goal,
        task_type: briefing.task_type || seeded.task_type,
        deliverable_kind:
          briefing.deliverable_kind || seeded.deliverable_kind || seeded.deliverableKind,
        success_criteria:
          briefing.success_criteria && briefing.success_criteria.length
            ? briefing.success_criteria
            : seeded.success_criteria || [],
        approach:
          briefing.approach && briefing.approach.length
            ? briefing.approach
            : seeded.approach || [],
        todos:
          briefing.todos && briefing.todos.length
            ? briefing.todos
            : seeded.todos || [],
        tools_priority:
          briefing.tools_priority && briefing.tools_priority.length
            ? briefing.tools_priority
            : seeded.tools_priority || [],
        executor_brief:
          String(briefing.executor_brief || '').trim() ||
          seeded.executor_brief ||
          '',
        template_id: seeded.template_id || briefing.template_id,
        max_steps: briefing.max_steps || seeded.max_steps,
        user_corrections: Understanding.asStringList(
          [].concat(
            briefing.user_corrections || [],
            seeded.user_corrections || seeded.userCorrections || [],
            threadCorrections,
          ),
        ),
        assumptions:
          briefing.assumptions && briefing.assumptions.length
            ? briefing.assumptions
            : seeded.assumptions || [],
        unknowns:
          briefing.unknowns && briefing.unknowns.length
            ? briefing.unknowns
            : seeded.unknowns || [],
        confidence:
          briefing.confidence != null ? briefing.confidence : seeded.confidence,
      });
    }
    briefing = enrichBriefing(briefing, userMessage);
    briefing = Understanding.applyCorrectionsWithRescore(
      briefing,
      threadCorrections,
      userMessage,
    );
    // Derive concrete done_when BEFORE the understanding gate so soft placeholders
    // never force a clarify pause on an otherwise clear deliver request.
    const derivedDone = deriveDoneWhen(
      briefing,
      userMessage,
      briefing.task_type,
    );
    if (derivedDone && !Understanding.isSoftDoneWhen(derivedDone)) {
      briefing.done_when = derivedDone;
      if (
        !(Array.isArray(briefing.success_criteria) && briefing.success_criteria.length)
      ) {
        briefing.success_criteria = [derivedDone];
      }
      if (
        !(Array.isArray(briefing.acceptance_tests) && briefing.acceptance_tests.length)
      ) {
        briefing.acceptance_tests = [derivedDone];
      }
    }
    // Light gate only — avoid a second full normalize that reshapes tools/files.
    briefing._confidenceExplicit = briefing.confidence != null;
    briefing = Understanding.applyUnderstandingGate(briefing, userMessage, {
      skipGate: false,
      confidenceExplicit: briefing.confidence != null,
    });
    delete briefing._confidenceExplicit;
    const modeInfo = Understanding.suggestMode(briefing, composerMode);
    if (!briefing.suggested_mode) briefing.suggested_mode = modeInfo.suggested_mode;
    if (!briefing.mode_reason) briefing.mode_reason = modeInfo.mode_reason;
    briefing.mode_suggestion = modeInfo;
    briefing.intent_contract = Understanding.formatIntentContract(briefing);

    // Re-pick skill from final task_type (+ design companion when relevant)
    const primarySkills = composeActiveSkills(
      autoSkillsAll,
      briefing.task_type,
      userMessage,
    );
    emit({ type: 'skills', skills: primarySkills });
    briefing.intent_contract = Understanding.formatIntentContract(briefing);
    ctx.doneWhen = briefing.done_when;
    if (ctx.blackboard) {
      ctx.blackboard.intentContract = briefing.intent_contract;
      ctx.blackboard.userCorrections = briefing.user_corrections || [];
      ctx.blackboard.deliverableKind = briefing.deliverable_kind;
      ctx.blackboard.understandingConfidence = briefing.confidence;
    }

    emit({
      type: 'analysis',
      briefing: {
        understanding: briefing.understanding,
        goal: briefing.goal,
        task_type: briefing.task_type,
        deliverable_kind: briefing.deliverable_kind,
        confidence: briefing.confidence,
        assumptions: briefing.assumptions,
        unknowns: briefing.unknowns,
        blocking_unknowns: briefing.blocking_unknowns,
        needs_clarification: !!briefing.needs_clarification,
        clarification_question: briefing.clarification_question,
        intent_contract: briefing.intent_contract,
        suggested_mode: briefing.suggested_mode,
        mode_reason: briefing.mode_reason,
        mode_suggestion: briefing.mode_suggestion,
        user_corrections: briefing.user_corrections,
        success_criteria: briefing.success_criteria,
        done_when: briefing.done_when,
        approach: briefing.approach,
        tools_priority: briefing.tools_priority,
        do_not: briefing.do_not,
        constraints: briefing.constraints,
        executor_brief: briefing.executor_brief,
        max_steps: briefing.max_steps,
        todos: briefing.todos,
        files: briefing.files,
        minimal_single_file: !!briefing.minimal_single_file,
      },
    });

    const understandingRecord = UnderstandingLog.buildUnderstandingRecord({
      userMessage,
      briefing,
      runId,
      outcome: 'analyzed',
      feedback: clarifyFeedback,
    });
    ctx.lastUnderstanding = understandingRecord;
    try {
      const thrAfter = await appendUnderstandingOutcome(threadId, understandingRecord);
      if (thrAfter && thrAfter.understandingSummary) {
        ctx.understandingSummary = thrAfter.understandingSummary;
      }
    } catch (e) {
      console.warn('understanding log failed', e && e.message);
    }
    logEvent(runLog, 'analysis', {
      task_type: briefing.task_type,
      deliverable_kind: briefing.deliverable_kind,
      goal: briefing.goal,
      done_when: briefing.done_when,
      confidence: briefing.confidence,
      needs_clarification: !!briefing.needs_clarification,
      clarifyAsked: !!understandingRecord.clarifyAsked,
      route: understandingRecord.route,
      router: understandingRecord.router,
      metrics: understandingRecord.metrics,
      user_corrections: (briefing.user_corrections || []).slice(0, 8),
    });
    emit({
      type: 'understanding',
      record: understandingRecord,
      summary: ctx.understandingSummary || null,
    });

    const isLightEarly =
      briefing.task_type === 'chat' ||
      briefing.deliverable_kind === 'answer' ||
      (briefing.task_type === 'question' &&
        (!briefing.todos || !briefing.todos.length) &&
        (!briefing.tools_priority || !briefing.tools_priority.length));

    // Team pipeline: intake → research → strategy (+ optional specialist mint)
    if (!ctx.blackboard) {
      ctx.blackboard = Blackboard.createBlackboard({
        goal: briefing.goal,
        doneWhen: briefing.done_when,
        todos: briefing.todos || [],
      });
    }
    try {
      const teamBoot = await TeamPipeline.bootstrapTeam({
        ctx,
        briefing,
        userMessage,
        emit,
        model,
        userId,
        generateCustomAgent,
        skipPhases:
          isLightEarly ||
          shouldBuildFastPath(briefing, userMessage) ||
          (ctx.agentInfo &&
            (ctx.agentInfo.name === 'explore' ||
              ctx.agentInfo.name === 'research')),
      });
      if (teamBoot && teamBoot.specialist && userId) {
        try {
          await users.saveCustomAgent(userId, teamBoot.specialist);
        } catch (e) {
          console.warn('specialist save failed', e && e.message);
        }
      }

      if (
        ctx.blackboard &&
        ctx.blackboard.strategyPath &&
        ctx.files[ctx.blackboard.strategyPath]
      ) {
        try {
          await persistFilePut(ctx, ctx.files[ctx.blackboard.strategyPath], {
            allowEmpty: true,
          });
        } catch (e) {
          console.warn('strategy persist failed', e && e.message);
        }
      }
    } catch (e) {
      console.warn('team bootstrap failed', e && e.message);
    }

    // Clarify first, then plan, then build — never plan-pause over an open question.
    if (briefing.needs_clarification && briefing.clarification_question) {
      const q = briefing.clarification_question;
      understandingRecord.outcome = 'clarify_asked';
      understandingRecord.clarifyAsked = true;
      understandingRecord.metrics = UnderstandingLog.scoreClarifyMetrics({
        clarifyAsked: true,
        outcome: 'clarify_asked',
        briefing,
        signals: Understanding.extractIntentSignals(userMessage),
        feedback: clarifyFeedback,
      });
      ctx.lastUnderstanding = understandingRecord;
      try {
        await appendUnderstandingOutcome(threadId, understandingRecord);
        await persistCheckpoint(threadId, {
          status: 'awaiting_clarify',
          runId,
          step: 0,
          userMessage,
          briefing,
          blackboard: Blackboard.serialize(ctx.blackboard),
          lastUnderstanding: understandingRecord,
          model,
        });
      } catch (e) {
        console.warn('clarify checkpoint failed', e && e.message);
      }
      await appendMessage(threadId, {
        role: 'assistant',
        content: q,
        meta: { clarification: true, understanding: understandingRecord },
      });
      emit({
        type: 'done',
        response: q,
        steps: 0,
        usage: { runId },
        clarification: true,
        understanding: understandingRecord,
      });
      return {
        response: q,
        steps: 0,
        usage: { runId },
        status: 'clarification',
        runId,
        understanding: understandingRecord,
      };
    }

    // Pause for plan approval when autonomy policy requires it.
    // Skip for clear HTML/app fast-path builds — deliver files immediately.
    const awaitPlan =
      !skipPlanApproval &&
      approvePlan !== true &&
      shouldAwaitPlan(autonomy, briefing.task_type, isLightEarly) &&
      !shouldBuildFastPath(briefing, userMessage);

    if (awaitPlan) {
      // Seed PLAN.md from briefing (rewrite incomplete/stale skeletons).
      const plan = PlanArtifact.ensureFromBriefing(ctx, briefing, userMessage, {
        reuseOk: true,
      });
      if (plan && plan.path && workspaceId && ctx.files[plan.path]) {
        try {
          await persistFilePut(ctx, ctx.files[plan.path], { allowEmpty: true });
        } catch {
          /* ignore */
        }
      }
      const parsed =
        (plan && plan.parsed) ||
        PlanArtifact.parsePlanArtifact(plan && plan.content);
      // Mirror artifact fields onto briefing for the approval UI.
      if (parsed) {
        if (parsed.goal) briefing.goal = briefing.goal || parsed.goal;
        if (parsed.doneWhen) briefing.done_when = briefing.done_when || parsed.doneWhen;
        if (parsed.steps && parsed.steps.length && !(briefing.approach && briefing.approach.length)) {
          briefing.approach = parsed.steps.slice();
        }
        if (parsed.files && parsed.files.length) {
          briefing.files = parsed.files.slice();
        }
        if (
          parsed.acceptance &&
          parsed.acceptance.length &&
          !(briefing.success_criteria && briefing.success_criteria.length)
        ) {
          briefing.success_criteria = parsed.acceptance.slice();
        }
      }
      ctx.planPath = plan.path;
      ctx.requirePlan = true;
      ctx.planApproved = false;
      ctx.blackboard = Blackboard.createBlackboard(
        Object.assign({}, ctx.blackboard || {}, {
          goal: briefing.goal,
          doneWhen: briefing.done_when,
          planPath: plan.path,
          todos: briefing.todos || [],
          requirePlan: true,
          planApproved: false,
          intentContract: briefing.intent_contract,
          userCorrections: briefing.user_corrections || [],
          deliverableKind: briefing.deliverable_kind,
          understandingConfidence: briefing.confidence,
        }),
      );
      TeamPipeline.setPhase(ctx.blackboard, 'plan', 'awaiting plan approval');
      await persistCheckpoint(threadId, {
        status: 'awaiting_plan',
        runId,
        step: 0,
        maxSteps: briefing.max_steps || iterations,
        messages: checkpointMessages(messages),
        fullText: '',
        toolsUsed: 0,
        todos: briefing.todos || [],
        briefing,
        userMessage,
        workflow,
        autonomy,
        planPath: plan.path,
        requirePlan: true,
        planApproved: false,
        blackboard: Blackboard.serialize(ctx.blackboard),
        model: model || (thr && thr.model) || 'default',
      });
      emit({
        type: 'awaiting_plan',
        runId,
        briefing,
        resume: true,
        autonomy,
        planPath: plan.path,
        planMarkdown: plan.content,
        planComplete: !!(parsed && parsed.complete),
        planErrors: (parsed && parsed.errors) || [],
      });
      logEvent(runLog, 'awaiting_plan', {
        autonomy,
        planPath: plan.path,
        complete: !!(parsed && parsed.complete),
      });
      return {
        response: '',
        steps: 0,
        usage: { runId },
        status: 'awaiting_plan',
        runId,
        briefing,
        planPath: plan.path,
      };
    }

    if (briefing.todos && briefing.todos.length) {
      ctx.todos = briefing.todos;
      emit({ type: 'todos', todos: ctx.todos });
    }
    ctx.taskType = briefing.task_type;
    ctx.briefing = briefing;
    // Re-resolve agent now that task_type is known (unless user picked one explicitly)
    if (!agentNameOpt) {
      ctx.agentInfo = Agents.resolveAgent({
        agentName: null,
        composerMode: ctx.composerMode,
        taskType: briefing.task_type,
        customAgents: ctx.customAgents || [],
      });
      ctx.permissionRuleset =
        (ctx.agentInfo && ctx.agentInfo.permission) || Permission.defaultRuleset();
      emit({
        type: 'agent',
        name: ctx.agentInfo.name,
        mode: ctx.agentInfo.mode,
        description: ctx.agentInfo.description || '',
        native: !!ctx.agentInfo.native,
      });
    }
    ctx.doneWhen = briefing.done_when || deriveDoneWhen(briefing, userMessage, briefing.task_type);
    if (
      !briefing.acceptance_tests ||
      !briefing.acceptance_tests.length
    ) {
      const seeded = Delivery.defaultAcceptanceForTask(
        briefing.task_type,
        briefing.goal,
        ctx,
      );
      const fromCriteria = Array.isArray(briefing.success_criteria)
        ? briefing.success_criteria
        : [];
      briefing.acceptance_tests = fromCriteria.length
        ? fromCriteria
        : seeded;
    }
    ctx.acceptanceTests = Delivery.normalizeAcceptanceTests(
      briefing.acceptance_tests,
    );
    const caps = budgetsForTaskType(
      briefing.task_type,
      briefing.max_steps,
      budgetMs,
    );
    iterations = Math.min(
      iterations,
      caps.maxSteps,
      smartMaxSteps(briefing.task_type, briefing.max_steps),
    );
    budget = Math.min(budget, caps.budgetMs);
    emit({
      type: 'budget',
      maxSteps: iterations,
      budgetMs: budget,
      remainingSteps: iterations,
      task_type: briefing.task_type,
      done_when: ctx.doneWhen,
    });
    if (briefing.max_steps) {
      iterations = Math.min(iterations, Number(briefing.max_steps) || iterations);
    }
    const role = subagentPrompt(briefing.task_type);
    emit({ type: 'subagent', role: role.name, label: role.label, soft: true });
    logEvent(runLog, 'subagent', { role: role.name });

    const skillLines = skillCatalogBrief(primarySkills, 2200);
    const designExtra = designTemplateBlock(userMessage);
    const bias = taskTypeBiasFor(ctx.agentInfo, briefing.task_type);

    ctx.blackboard = Blackboard.createBlackboard(
      Object.assign({}, ctx.blackboard || {}, {
        goal: briefing.goal,
        doneWhen: ctx.doneWhen || briefing.done_when,
        planPath: ctx.planPath,
        todos: briefing.todos || ctx.todos,
        filesTouched: ctx.filesTouched,
        requirePlan: !!ctx.requirePlan,
        planApproved: !!ctx.planApproved,
      }),
    );
    if (!ctx.blackboard.phase) {
      TeamPipeline.setPhase(
        ctx.blackboard,
        ctx.planApproved || !ctx.requirePlan ? 'execute' : 'plan',
        'executor start',
      );
    }

    // Chat / simple question: skip the tool loop — answer once as executor with no tools pressure
    const isLight =
      briefing.task_type === 'chat' ||
      (briefing.task_type === 'question' &&
        (!briefing.todos || !briefing.todos.length) &&
        (!briefing.tools_priority || !briefing.tools_priority.length));

    const projectCtx = projectContextBlock(ctx);
    messages.push({
      role: 'user',
      content:
        '# Named agent: ' +
        ((ctx.agentInfo && ctx.agentInfo.name) || 'build') +
        '\n' +
        Agents.agentSystemExtra(ctx.agentInfo, {
          thoroughness: ctx.thoroughness,
          taskTypeBias: bias,
        }) +
        (skillLines ? '\n\n' + skillLines : '') +
        (designExtra || '') +
        '\n\n# Playbook\n' +
        playbookForTaskType(briefing.task_type) +
        '\n' +
        workspacePlaybookExtra(briefing.task_type) +
        '\n' +
        (VerifyLoop.formatVerifyHint(
          VerifyLoop.nextVerifySteps({
            taskType: briefing.task_type,
            diagnostics:
              (ctx.lastDiagnostics && ctx.lastDiagnostics.problems) || [],
          }),
        ) || '') +
        '\n\n' +
        formatExecutorPrompt(briefing, userMessage) +
        '\n\n' +
        TeamPipeline.formatTeamPrompt(ctx.blackboard) +
        '\n\n' +
        Blackboard.formatForPrompt(ctx.blackboard) +
        '\n\n' +
        inventory.text +
        '\n\n' +
        projectCtx.text +
        '\n\n' +
        (function ideCtx() {
          const parts = [];
          if (ctx.roots && ctx.roots.length) {
            parts.push('Workspace roots: ' + ctx.roots.join(', '));
          }
          if (ctx.activeFile) {
            parts.push('Active file: ' + ctx.activeFile);
          }
          if (ctx.lastPr && ctx.lastPr.html_url) {
            parts.push(
              'Last PR: #' +
                (ctx.lastPr.number || '') +
                ' ' +
                ctx.lastPr.html_url,
            );
          }
          if (ctx.lastCi) {
            parts.push(
              'CI: ' + (ctx.ciOk ? 'green' : 'not green') + ' on ' + (ctx.lastCi.ref || ''),
            );
          }
          if (ctx.openFiles && ctx.openFiles.length) {
            parts.push('Open tabs: ' + ctx.openFiles.slice(0, 12).join(', '));
          }
          const probs =
            (ctx.lastDiagnostics && ctx.lastDiagnostics.problems) || [];
          if (probs.length) {
            parts.push(
              'Open problems (' +
                probs.length +
                '): prefer fixing these first\n' +
                probs
                  .slice(0, 8)
                  .map(
                    (pr) =>
                      '- ' +
                      (pr.file || '') +
                      ':' +
                      (pr.line || 1) +
                      ' ' +
                      (pr.message || ''),
                  )
                  .join('\n'),
            );
          }
          let ragBlock = '';
          try {
            const rev = Number(ctx.revision || 0);
            let index = ContextCache.getCachedIndex(ctx.workspaceId, rev);
            if (!index) {
              index = ContextRag.buildIndex(ctx.files || {}, { revision: rev });
              ContextCache.setCachedIndex(ctx.workspaceId, rev, index);
            }
            const pack = ContextRag.packContext({
              files: ctx.files || {},
              index,
              query: userMessage || (briefing && briefing.goal) || '',
              activeFile: ctx.activeFile || '',
              openFiles: ctx.openFiles || [],
              mode: 'hybrid',
              diagnostics:
                (ctx.lastDiagnostics && ctx.lastDiagnostics.problems) ||
                ctx.problems ||
                [],
              maxChars: 10000,
            });
            if (pack && pack.text) {
              ragBlock =
                '\n# Retrieved workspace context (Layer 2 hybrid/priompt)\n' +
                pack.text;
              ctx._ragHits = pack.hits || [];
              ctx._contextMeta = pack.indexMeta || null;
            }
          } catch (e) {
            ragBlock = '';
          }
          return (parts.length ? '# IDE context\n' + parts.join('\n') : '') + ragBlock;
        })() +
        '\n\n' +
        buildRunMemoryPack({
          goal: briefing.goal,
          taskType: briefing.task_type,
          todos: briefing.todos,
          workflow,
          autonomy,
          doneWhen: ctx.doneWhen || briefing.done_when,
          deliverySuccess: !!ctx.deliverySuccess,
          phase: ctx.blackboard && ctx.blackboard.phase,
          filesTouched: ctx.filesTouched,
          lastFailures: ctx.lastFailures,
        }),
    });
    // Baseline SystemContext fingerprint — updates only emit when ambient state changes
    ctx._systemContextFp = SelfAwareness.contextFingerprint(ctx);
    if (!ctx._agentsAttached) ctx._agentsAttached = new Set();

    // Ensure tool-call protocol is always in the stack (BYOK + Worker).
    // Keep it first so models see format before executor orders.
    if (!messages.some((m) => m && m.role === 'system')) {
      messages.unshift({
        role: 'system',
        content:
          CHATRE_AGENT_PROMPT +
          '\n\n' +
          Agents.agentSystemExtra(ctx.agentInfo, { thoroughness: ctx.thoroughness }),
      });
    }

    // Document fast path: one content generation + create_pdf/create_document (saves tokens)
    if (shouldDocumentFastPath(briefing, userMessage) && !isLight && !(ctx.agentInfo && (ctx.agentInfo.name === 'plan' || ctx.agentInfo.name === 'explore'))) {
      emit({ type: 'phase', phase: 'execute', text: 'Writing document into workspace…' });
      const wantPdf = /\bpdf\b/i.test(userMessage) || (briefing.tools_priority || []).indexOf('create_pdf') === 0;
      let bodyText = '';
      try {
        bodyText = await chatWorkerStreaming({
          messages: trimMessages([
            {
              role: 'user',
              content:
                'Write the FULL body for this request as clean markdown. No preamble. No tool blocks.\n\n' +
                String(userMessage || '') +
                '\n\nGoal: ' +
                (briefing.goal || '') +
                '\nDone when: ' +
                (ctx.doneWhen || '') +
                '\n' +
                DESIGN_DOC_HINT,
            },
          ]),
          model,
          userId,
          maxTokens: TOKEN_BUDGETS.document_body,
          agent: false,
          onToken: (delta) => {
            bodyText += delta;
            emit({ type: 'token', text: delta });
          },
        });
      } catch (err) {
        bodyText = '# Document\n\n' + String(userMessage || '');
      }
      bodyText = cleanText(bodyText) || String(userMessage || '');
      const title =
        (briefing.goal || 'Document').replace(/^create\s+/i, '').slice(0, 80) ||
        'Document';
      const toolName = wantPdf ? 'create_pdf' : 'create_document';
      emit({
        type: 'tool_start',
        tool: toolName,
        params: { title: title, content: bodyText.slice(0, 200) + '…' },
        id: 'fast_' + toolName,
      });
      const result = await executeRemoteTool(
        {
          tool: toolName,
          params: { title: title, content: bodyText },
          id: 'fast_' + toolName,
        },
        ctx,
      );
      toolsUsed += 1;
      if (result && result.path) ctx.filesTouched.push(result.path);
      if (isDeliverySuccess(toolName, result)) {
        ctx.deliverySuccess = true;
        workflow = recordToolPhase(workflow, toolName);
      }
      emit({
        type: 'tool_result',
        tool: toolName,
        id: 'fast_' + toolName,
        result: shrinkToolResult(result),
      });
      const answer = result && result.ok
        ? '<answer>\nCreated **' +
          (result.path || title) +
          '** in your workspace' +
          (result.pages ? ' (' + result.pages + ' pages)' : '') +
          '.\nOpen it from the Files panel.\n</answer>'
        : '<answer>\nCould not create the document: ' +
          ((result && result.error) || 'unknown error') +
          '\n</answer>';
      const diag = buildRunDiagnostics({
        taskType: briefing.task_type,
        doneWhen: ctx.doneWhen,
        steps: 1,
        toolsUsed: 1,
        deliverySuccess: !!ctx.deliverySuccess,
        filesTouched: ctx.filesTouched,
        stopReason: result && result.ok ? 'document_fast_path' : 'document_fast_path_failed',
        primarySkill: primarySkills[0] || null,
        model,
        workspaceFileCount: inventory.fileCount + (result && result.ok ? 1 : 0),
      });
      emit({ type: 'diagnostics', diagnostics: diag });
      if (!(result && result.ok && ctx.deliverySuccess)) {
        return finishRun({
          threadId,
          model: model || (thr && thr.model) || 'default',
          full: cleanText(answer),
          usage: { runId, model, toolsUsed: 1, steps: 1, diagnostics: diag },
          toolsUsed: 1,
          steps: 1,
          emit,
          status: 'done',
          ctx,
          runLog,
        });
      }
      messages.push({ role: 'assistant', content: cleanText(answer) });
      messages.push({
        role: 'user',
        content:
          '[internal] Document artifact written to ' +
          (result.path || 'workspace') +
          '. Self-check against the user request and acceptance tests. ' +
          'If thin, incomplete, or wrong format, improve it with create_pdf/create_document/csv_write/write_file. ' +
          'Then finish with a short confirmation of the real path. Do not invent Download links.',
      });
      toolSummaryParts.push(
        'document_fast_path → ' + (result.path || toolName) + ' ok',
      );
    }

    // HTML/CSS/JS (and similar) builds: generate + write_file server-side so
    // the model cannot "narrate" files that never land in the workspace.
    if (shouldBuildFastPath(briefing, userMessage) && !isLight && !(ctx.agentInfo && (ctx.agentInfo.name === 'plan' || ctx.agentInfo.name === 'explore'))) {
      emit({
        type: 'phase',
        phase: 'execute',
        text: 'Generating project files…',
      });
      const target = resolveProjectTarget(
        userMessage,
        briefing.goal,
        briefing,
      );
      const slug = target.slug;
      const minimalBuild = isMinimalPageRequest(userMessage, briefing.goal);
      const promptOpts = {
        minimal: minimalBuild,
        preferredFile: target.relativePath || 'index.html',
      };
      let genText = '';
      const buildBudget = Math.min(
        Math.max(TOKEN_BUDGETS.document_body || 1800, 1800),
        2200,
      );
      try {
        // Do not stream generation into chat — only keep the final buffer.
        genText = await chatWorkerStreaming({
          messages: trimMessages([
            {
              role: 'user',
              content: buildFilesPrompt(
                userMessage,
                briefing.goal,
                slug,
                promptOpts,
              ),
            },
          ]),
          model,
          userId,
          maxTokens: buildBudget,
          agent: false,
        });
        genText = String(genText || '');
      } catch (err) {
        if (isCreditError(err)) {
          const { provider } = parseModel(model);
          if (provider !== 'chatre') {
            const workersModel = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
            emit({
              type: 'phase',
              phase: 'execute',
              text:
                'BYOK credits too low — generating on Workers AI, then writing files…',
            });
            model = workersModel;
            usage.model = model;
            try {
              genText = String(
                (await chatWorkerStreaming({
                  messages: trimMessages([
                    {
                      role: 'user',
                      content: buildFilesPrompt(userMessage, briefing.goal, slug, promptOpts),
                    },
                  ]),
                  model,
                  userId,
                  maxTokens: buildBudget,
                  agent: false,
                })) || '',
              );
            } catch (errW) {
              genText = '';
              emit({
                type: 'phase',
                phase: 'execute',
                text:
                  'LLM generation unavailable — writing a playable scaffold…',
              });
            }
          } else {
            const afford = affordableTokensFromError(err);
            const retryBudget = Math.max(64, Math.min(900, (afford || 256) - 24));
            emit({
              type: 'phase',
              phase: 'execute',
              text:
                'Generation budget limited by API credits; retrying smaller…',
            });
            try {
              genText = String(
                (await chatWorkerStreaming({
                  messages: trimMessages([
                    {
                      role: 'user',
                      content: buildFilesPrompt(userMessage, briefing.goal, slug, promptOpts),
                    },
                  ]),
                  model,
                  userId,
                  maxTokens: retryBudget,
                  agent: false,
                })) || '',
              );
            } catch (err2) {
              genText = '';
              emit({
                type: 'phase',
                phase: 'execute',
                text:
                  'LLM generation unavailable (credits) — writing a playable scaffold…',
              });
            }
          }
        } else {
          genText = '';
        }
      }
      let parsed = parseGeneratedFiles(genText);
      if (!parsed || !parsed.files.length) {
        parsed = {
          slug,
          files: extractFilesFromNarration(genText),
        };
      }
      if (!parsed || !parsed.files || !parsed.files.length) {
        parsed = scaffoldHtmlProject(slug, userMessage, briefing.goal, {
          minimal: minimalBuild,
          relativePath: target.relativePath || 'index.html',
        });
        emit({
          type: 'phase',
          phase: 'execute',
          text: minimalBuild
            ? 'Using built-in minimal HTML scaffold (LLM output missing/invalid)…'
            : 'Using built-in playable scaffold (LLM output missing/invalid)…',
        });
      }
      // Prefer explicit user/briefing path over model-invented slug
      const useSlug =
        target.source === 'slug' ? parsed.slug || slug : slug;
      if (parsed && parsed.files) {
        parsed.files = constrainFilesToRequest(
          parsed.files,
          target,
          minimalBuild,
        );
      }
      const root = '/home/user/projects/' + useSlug;
      if (minimalBuild) ctx.skipAgentsMd = true;
      ensureProject(ctx, useSlug, {
        goal: briefing.goal || userMessage,
        stack: minimalBuild ? 'html' : 'html,css,js',
        agentsMd: minimalBuild ? false : undefined,
      });
      const written = [];
      if (parsed.files && parsed.files.length) {
        await executeRemoteTool(
          {
            tool: 'create_directory',
            params: { path: root },
            id: 'fast_mkdir',
          },
          ctx,
        );
        for (let fi = 0; fi < parsed.files.length; fi++) {
          const f = parsed.files[fi];
          const path =
            f.relativePath.indexOf('/home/user/') === 0
              ? f.relativePath
              : root + '/' + f.relativePath.replace(/^\/+/, '');
          emit({
            type: 'tool_start',
            tool: 'write_file',
            params: { path: path, content: '(full file)' },
            id: 'fast_write_' + fi,
          });
          const result = await executeRemoteTool(
            {
              tool: 'write_file',
              params: { path: path, content: f.content },
              id: 'fast_write_' + fi,
            },
            ctx,
          );
          toolsUsed += 1;
          if (result && result.ok) {
            written.push(path);
            if (result.path) ctx.filesTouched.push(result.path);
            if (isDeliverySuccess('write_file', result)) {
              ctx.deliverySuccess = true;
              workflow = recordToolPhase(workflow, 'write_file');
            }
          }
          emit({
            type: 'tool_result',
            tool: 'write_file',
            id: 'fast_write_' + fi,
            result: shrinkToolResult(result),
          });
        }
      }
      if (ctx.deliverySuccess && written.length) {
        emit({
          type: 'phase',
          phase: 'execute',
          text: 'Running live preview + debug…',
        });
        emit({
          type: 'tool_start',
          tool: 'preview_project',
          params: { path: root },
          id: 'fast_preview',
        });
        const previewResult = runPreviewProject(ctx, { path: root });
        toolsUsed += 1;
        workflow = recordToolPhase(workflow, 'preview_project');
        if (previewResult && previewResult.preview) {
          emit({
            type: 'preview',
            preview: previewResult.preview,
            errors: previewResult.errors || [],
            warnings: previewResult.warnings || [],
            ok: !!previewResult.ok,
            path: previewResult.path,
            localhost: previewResult.localhost,
            port: previewResult.port,
          });
        }
        emit({
          type: 'tool_result',
          tool: 'preview_project',
          id: 'fast_preview',
          result: shrinkToolResult(previewResult),
        });
        if (previewResult && previewResult.ok) {
          ctx.previewOk = true;
          ctx.verifiedAny = true;
          workflow.verified = true;
          workflow.previewFailed = false;
          const answer =
            '<answer>\nCreated **' +
            useSlug +
            '** in your workspace:\n\n' +
            written.map((p) => '- `' + p + '`').join('\n') +
            '\n\nLive preview: `' +
            (previewResult.localhost || 'http://localhost') +
            '` (opened in Preview).\nDebug: passed.\n</answer>';
          emit({ type: 'text', text: cleanText(answer), final: false });
          messages.push({ role: 'assistant', content: cleanText(answer) });
          messages.push({
            role: 'user',
            content:
              '[internal] Scaffold + preview_project ok for ' +
              useSlug +
              '. Self-reflect: does this fully satisfy the user request (UX, features, design, edge cases)? ' +
              'If anything is missing or placeholder-quality, patch/write_file then preview_project again. ' +
              'Only then stop with real paths. Prefer quality over speed.',
          });
          toolSummaryParts.push(
            'build_fast_path → ' + written.length + ' files, preview ok',
          );
        } else {
          ctx.previewFailed = true;
          workflow.previewFailed = true;
          messages.push({
            role: 'assistant',
            content:
              'Created files under ' +
              root +
              ' but preview_project found errors.',
          });
          messages.push({
            role: 'user',
            content:
              '[internal] preview_project failed:\n' +
              String((previewResult && previewResult.text) || 'unknown') +
              '\nFix with patch_file/write_file, then call preview_project again. Do not claim done. Do not narrate this message.',
          });
          emit({
            type: 'phase',
            phase: 'execute',
            text: 'Preview found errors — fixing…',
          });
        }
      }
      // Fall through to normal tool loop if generation failed or preview failed
      if (!(ctx.deliverySuccess && written.length && ctx.previewOk)) {
        emit({
          type: 'phase',
          phase: 'execute',
          text: 'Fast path incomplete — continuing with tools…',
        });
      }
    }

    if (isLight) {
      emit({ type: 'phase', phase: 'execute', text: 'Answering…' });
      let answer = '';
      try {
        answer = await chatWorkerStreaming({
          messages: trimMessages(messages),
          model,
          userId,
          maxTokens: TOKEN_BUDGETS.final,
          agent: true,
          onToken: (delta) => {
            answer += delta;
            emit({ type: 'token', text: delta });
          },
        });
      } catch (err) {
        answer =
          'I could not complete that: ' +
          (err instanceof Error ? err.message : String(err));
      }
      const cleaned = cleanText(answer);
      // Chat/question answers are successful deliveries of text — not workspace proofs.
      ctx.deliverySuccess = true;
      ctx.previewOk = true;
      ctx.testsOk = true;
      ctx.taskType = briefing.task_type || 'chat';
      ctx.doneWhen =
        briefing.done_when ||
        (briefing.task_type === 'chat'
          ? 'Friendly reply delivered'
          : 'Direct answer delivered');
      const diag = buildRunDiagnostics({
        taskType: briefing.task_type,
        doneWhen: ctx.doneWhen,
        steps: 1,
        toolsUsed: 0,
        deliverySuccess: true,
        stopReason: 'light_chat',
        primarySkill: primarySkills[0] || null,
        model,
        workspaceFileCount: inventory.fileCount,
      });
      emit({ type: 'diagnostics', diagnostics: diag });
      return finishRun({
        threadId,
        model,
        full: cleaned,
        usage: { runId, model, diagnostics: diag },
        toolsUsed: 0,
        steps: 1,
        emit,
        status: 'done',
        ctx,
        runLog,
      });
    }

    emit({ type: 'phase', phase: 'execute', text: 'Executing brief…' });
    promptTokens = estimateTokens(JSON.stringify(messages));
  }

  const usage = {
    model: model || (thr && thr.model) || 'default',
    runId,
    steps: startStep,
    toolsUsed,
    promptTokensEst: promptTokens,
    completionTokensEst: completionTokens,
    totalTokensEst: promptTokens + completionTokens,
  };

  await persistCheckpoint(threadId, {
    status: 'running',
    runId,
    step: startStep,
    maxSteps: iterations,
    messages: checkpointMessages(messages),
    fullText: full,
    toolsUsed,
    usage: { ...usage },
    todos: ctx.todos,
    briefing: ctx.briefing,
    toolSummaryParts,
    workflow,
    startedAt: new Date(startedAt).toISOString(),
    model: usage.model,
  });

  const overBudget = () =>
    Date.now() - startedAt >= budget ||
    !!(ctx.spendTracker && ctx.spendTracker.overBudget());

  function tryAutoExtend(reason, step) {
    if (!shouldAutoResume(autonomy, reason, autoResumeCount)) return false;
    autoResumeCount += 1;
    budget += AUTO_RESUME_EXTRA_MS;
    iterations = Math.min(iterations + AUTO_RESUME_EXTRA_STEPS, 40);
    emit({
      type: 'auto_resume',
      reason,
      count: autoResumeCount,
      max: MAX_AUTO_RESUMES,
      budgetMs: budget,
      maxSteps: iterations,
      step,
    });
    messages.push({
      role: 'user',
      content:
        '[internal] Budget extended (' +
        autoResumeCount +
        '/' +
        MAX_AUTO_RESUMES +
        '). Finish remaining todos with tools, then give the final summary WITHOUT tools. Do not narrate this message.\n\n' +
        buildRunMemoryPack({
          goal: (ctx.briefing && ctx.briefing.goal) || userMessage,
          taskType: ctx.taskType,
          todos: ctx.todos,
          workflow,
          filesTouched: ctx.filesTouched,
          lastFailures: ctx.lastFailures,
          autonomy,
        }),
    });
    return true;
  }

  // Resume after tool approval: run the pending tool immediately.
  if (
    isResume &&
    existingRun &&
    existingRun.status === 'awaiting_approval' &&
    existingRun.pendingTool &&
    (approvedTools.has(existingRun.pendingTool) ||
      approvedTools.has('*') ||
      !toolNeedsApproval(autonomy, existingRun.pendingTool, approvedTools))
  ) {
    approvedTools.add(existingRun.pendingTool);
    ctx.approvedTools = approvedTools;
    const call = {
      tool: existingRun.pendingTool,
      params: existingRun.pendingParams || {},
      id: 'approved_' + existingRun.pendingTool,
    };
    emit({
      type: 'tool_start',
      tool: call.tool,
      params: call.params,
      id: call.id,
      approved: true,
    });
    const result = await applySpillToResult(
      await executeRemoteTool(call, ctx),
      ctx,
      call.tool,
    );
    workflow = recordToolPhase(workflow, call.tool);
    toolsUsed += 1;
    if (result && result.path) ctx.filesTouched.push(result.path);
    if (result && result.spill_path) ctx.filesTouched.push(result.spill_path);
    emit({ type: 'tool_result', tool: call.tool, id: call.id, result: result });
    messages.push({
      role: 'user',
      content:
        'Approved tool result for ' +
        call.tool +
        ':\n' +
        JSON.stringify(result, null, 2).slice(0, 4000) +
        '\n\nContinue.',
    });
  }

  // Always keep tool protocol in the stack (resume + BYOK + Worker).
  if (
    Array.isArray(messages) &&
    !messages.some((m) => m && m.role === 'system' && /Tool calling format/i.test(m.content || ''))
  ) {
    messages.unshift({
      role: 'system',
      content:
        CHATRE_AGENT_PROMPT +
        '\n\n' +
        Agents.agentSystemExtra(ctx.agentInfo, {
          thoroughness: ctx.thoroughness,
        }),
    });
  }

  for (let i = startStep; i < iterations; i++) {
    if (overBudget()) {
      if (tryAutoExtend('time_budget', i)) {
        continue;
      }
      await persistCheckpoint(threadId, {
        status: 'interrupted',
        runId,
        step: i,
        maxSteps: iterations,
        messages: checkpointMessages(messages),
        fullText: full,
        toolsUsed,
        usage: { ...usage, toolsUsed, steps: i },
        todos: ctx.todos,
        workflow,
        reason: 'time_budget',
        autoResumeCount,
        criticRepaired,
        approvedTools: [...approvedTools],
        filesTouched: ctx.filesTouched,
        lastFailures: ctx.lastFailures,
        autonomy,
        model: usage.model,
      });
      emit({
        type: 'interrupted',
        runId,
        step: i,
        reason: 'time_budget',
        resume: true,
        autoResume: false,
        usage: { ...usage, toolsUsed, steps: i },
        response: full || '(interrupted — resume to continue)',
      });
      return {
        response: full,
        steps: i,
        usage: { ...usage, toolsUsed },
        status: 'interrupted',
        runId,
      };
    }

    if (shouldCompact(messages, CONTEXT_SOFT_LIMIT) && !ctx._compactedOnce) {
      ctx._compactedOnce = true;
      emit({ type: 'phase', phase: 'compact', text: 'Compacting context…' });
      try {
        messages = await compactMessages({
          messages,
          model,
          userId,
          goal: (ctx.briefing && ctx.briefing.goal) || userMessage,
          runState: {
            phase: (ctx.blackboard && ctx.blackboard.phase) || null,
            doneWhen: ctx.doneWhen || (ctx.briefing && ctx.briefing.done_when),
            filesTouched: ctx.filesTouched,
            openTodos: (ctx.todos || []).filter((t) => t && t.status !== 'done'),
            failures: ctx.lastFailures,
            deliverySuccess: !!ctx.deliverySuccess,
          },
        });
        // Keep system prompt first
        if (!messages.some((m) => m && m.role === 'system')) {
          messages.unshift({
            role: 'system',
            content:
              CHATRE_AGENT_PROMPT +
              '\n\n' +
              Agents.agentSystemExtra(ctx.agentInfo, {
                thoroughness: ctx.thoroughness,
              }),
          });
        }
        // Reset SystemContext epoch after compaction — next admit emits a fresh update
        ctx._systemContextFp = null;
      } catch (e) {
        /* keep messages */
      }
    }

    usage.steps = i + 1;
    emit({
      type: 'thinking',
      step: i + 1,
      max: iterations,
      usage: { ...usage },
      workflow: { ...workflow },
      todos: ctx.todos,
    });

    // SystemContext-lite: mid-conversation ambient updates
    const ctxUpdate = SelfAwareness.admitContextUpdate(
      ctx,
      ctx._compactedOnce && !ctx._systemContextFp ? { force: true } : null,
    );
    if (ctxUpdate) {
      messages.push({ role: 'user', content: ctxUpdate });
    }

    const isLastStep = i >= iterations - 1;
    if (isLastStep) {
      messages.push({
        role: 'user',
        content: SelfAwareness.maxStepsPrompt(
          ctx.doneWhen || (ctx.briefing && ctx.briefing.done_when),
        ),
      });
      emit({
        type: 'phase',
        phase: 'max_steps',
        text: 'Step budget exhausted — text-only summary',
      });
    }

    let stepText = '';
    let structuredCalls = [];
    let finalStepText = '';

    try {
      const structured = await chatWorkerWithTools({
        messages: trimMessages(messages),
        model,
        userId,
        maxTokens: TOKEN_BUDGETS.executor,
        agent: true,
        tools: isLastStep ? [] : TOOL_DEFS,
        onToken: (delta) => {
          stepText += delta;
          completionTokens += estimateTokens(delta);
          usage.completionTokensEst = completionTokens;
          usage.totalTokensEst = promptTokens + completionTokens;
          emit({ type: 'token', delta, step: i + 1 });
        },
      });
      finalStepText = structured.text || stepText;
      structuredCalls = isLastStep ? [] : structured.toolCalls || [];
    } catch (e) {
      if (isCreditError(e)) {
        const { provider } = parseModel(model);
        // Prefer BYOK when it works; if credits are dead, finish the build on Workers AI
        // instead of streaming a truncated tutorial essay with a 400-token budget.
        if (provider !== 'chatre') {
          const workersModel = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
          emit({
            type: 'text',
            text:
              'BYOK credits too low — switching this run to Workers AI (' +
              workersModel +
              ') so tools can still write files…',
            final: false,
            step: i + 1,
          });
          model = workersModel;
          usage.model = model;
          try {
            const structured = await chatWorkerWithTools({
              messages: trimMessages(messages),
              model,
              userId,
              maxTokens: TOKEN_BUDGETS.executor,
              agent: true,
              tools: TOOL_DEFS,
              onToken: (delta) => {
                stepText += delta;
                completionTokens += estimateTokens(delta);
                usage.completionTokensEst = completionTokens;
                usage.totalTokensEst = promptTokens + completionTokens;
                emit({ type: 'token', delta, step: i + 1 });
              },
            });
            finalStepText = structured.text || stepText;
            structuredCalls = structured.toolCalls || [];
          } catch (e2) {
            const msg =
              'Cannot continue: BYOK credits are exhausted and Workers AI also failed (' +
              String(e2.message || e2) +
              '). Add OpenRouter credits or retry with a Chatre/Workers model.';
            emit({ type: 'text', text: msg, final: true, step: i + 1 });
            full += (full ? '\n\n' : '') + msg;
            await persistCheckpoint(threadId, {
              status: 'failed',
              runId,
              step: i + 1,
              maxSteps: iterations,
              messages: checkpointMessages(messages),
              fullText: full,
              toolsUsed,
              usage: { ...usage, error: String(e2.message || e2) },
              todos: ctx.todos,
              workflow,
              model: usage.model,
              deliverySuccess: false,
            });
            return {
              response: full,
              steps: i + 1,
              usage: { ...usage, toolsUsed },
              status: 'failed',
              runId,
              error: 'credits',
            };
          }
        } else {
          const afford = affordableTokensFromError(e);
          const budget = Math.max(64, Math.min(TOKEN_BUDGETS.executor, (afford || 256) - 24));
          emit({
            type: 'text',
            text:
              'Provider credit limit hit' +
              (afford != null ? ' (afford ~' + afford + ' tokens)' : '') +
              '. Retrying with a smaller budget…',
            final: false,
            step: i + 1,
          });
          try {
            finalStepText = await chatWorkerStreaming({
              messages: trimMessages(messages),
              model,
              userId,
              maxTokens: budget,
              agent: true,
              onToken: (delta) => {
                stepText += delta;
                completionTokens += estimateTokens(delta);
                usage.completionTokensEst = completionTokens;
                usage.totalTokensEst = promptTokens + completionTokens;
                emit({ type: 'token', delta, step: i + 1 });
              },
            });
            finalStepText = finalStepText || stepText;
          } catch (e2) {
            const msg =
              'Cannot continue: API credits are too low for tool calls. Add credits at https://openrouter.ai/settings/credits or switch the model to a Chatre/Workers model, then start a new message.';
            emit({ type: 'text', text: msg, final: true, step: i + 1 });
            full += (full ? '\n\n' : '') + msg;
            await persistCheckpoint(threadId, {
              status: 'failed',
              runId,
              step: i + 1,
              maxSteps: iterations,
              messages: checkpointMessages(messages),
              fullText: full,
              toolsUsed,
              usage: { ...usage, error: String(e2.message || e2) },
              todos: ctx.todos,
              workflow,
              model: usage.model,
              deliverySuccess: false,
            });
            return {
              response: full,
              steps: i + 1,
              usage: { ...usage, toolsUsed },
              status: 'failed',
              runId,
              error: 'credits',
            };
          }
        }
      } else {
        // Fallback to streaming text-only + markdown tool parse
        emit({
          type: 'text',
          text: 'Structured tools unavailable (' + (e.message || e) + '); falling back to stream.',
          final: false,
          step: i + 1,
        });
        finalStepText = await chatWorkerStreaming({
          messages: trimMessages(messages),
          model,
          userId,
          maxTokens: TOKEN_BUDGETS.executor,
          agent: true,
          onToken: (delta) => {
            stepText += delta;
            completionTokens += estimateTokens(delta);
            usage.completionTokensEst = completionTokens;
            usage.totalTokensEst = promptTokens + completionTokens;
            emit({ type: 'token', delta, step: i + 1 });
          },
        });
        finalStepText = finalStepText || stepText;
      }
    }

    completionTokens = Math.max(completionTokens, estimateTokens(finalStepText));
    usage.completionTokensEst = completionTokens;
    usage.totalTokensEst = promptTokens + completionTokens;

    const tools = isLastStep
      ? []
      : parseToolCalls(finalStepText, structuredCalls);
    const cleaned = cleanText(finalStepText);
    const shouldForceTools = ['build', 'debug', 'document', 'git', 'run', 'mixed'].includes(
      String(ctx.taskType || 'mixed'),
    );
    const fakeClaim =
      shouldForceTools &&
      !ctx.deliverySuccess &&
      looksLikeFakeDeliveryClaim(cleaned || finalStepText);

    if (cleaned && !(fakeClaim && tools.length === 0)) {
      full += (full ? '\n\n' : '') + cleaned;
      emit({
        type: 'text',
        text: cleaned,
        final: tools.length === 0 && !!ctx.deliverySuccess,
        step: i + 1,
        usage: { ...usage },
      });
    } else if (fakeClaim && tools.length === 0) {
      emit({
        type: 'phase',
        phase: 'execute',
        text: 'Waiting for tool calls…',
      });
    }

    if (!tools.length) {
      if (i === startStep && !isResume && shouldForceTools && toolsUsed === 0) {
        messages.push({ role: 'assistant', content: finalStepText || '' });
        messages.push({
          role: 'user',
          content:
            '[internal] Call tools now for this task — do not stop with chat only. Do not narrate this message. For builds use write_file under /home/user/projects/<slug>/ — never Python open()/zipfile theatre.',
        });
        await persistCheckpoint(threadId, {
          status: 'running',
          runId,
          step: i + 1,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed,
          usage: { ...usage },
          todos: ctx.todos,
          workflow,
          model: usage.model,
        });
        continue;
      }

      // Block "I created the files" theatre — nudge repeatedly until delivery
      const nudgeCount = Number(ctx._forcedDeliveryNudge || 0);
      if (
        shouldForceTools &&
        !ctx.deliverySuccess &&
        !artifactLooksDone(ctx.doneWhen, ctx) &&
        nudgeCount < 4 &&
        i < iterations - 1
      ) {
        ctx._forcedDeliveryNudge = nudgeCount + 1;
        // Try salvage from the model's own dump before asking again
        const salvaged = extractFilesFromNarration(
          (full || '') + '\n' + (finalStepText || ''),
        );
        if (salvaged.length) {
          const target = resolveProjectTarget(
            userMessage || (ctx.briefing && ctx.briefing.goal),
            ctx.briefing && ctx.briefing.goal,
            ctx.briefing,
          );
          const slug = target.slug;
          const root = target.root || '/home/user/projects/' + slug;
          await executeRemoteTool(
            {
              tool: 'create_directory',
              params: { path: root },
              id: 'salvage_mkdir',
            },
            ctx,
          );
          for (let si = 0; si < salvaged.length; si++) {
            const f = salvaged[si];
            const path = root + '/' + f.relativePath.replace(/^\/+/, '');
            emit({
              type: 'tool_start',
              tool: 'write_file',
              params: { path: path },
              id: 'salvage_' + si,
            });
            const result = await executeRemoteTool(
              {
                tool: 'write_file',
                params: { path: path, content: f.content },
                id: 'salvage_' + si,
              },
              ctx,
            );
            toolsUsed += 1;
            if (result && result.ok) {
              if (result.path) ctx.filesTouched.push(result.path);
              ctx.deliverySuccess = true;
              workflow = recordToolPhase(workflow, 'write_file');
            }
            emit({
              type: 'tool_result',
              tool: 'write_file',
              id: 'salvage_' + si,
              result: shrinkToolResult(result),
            });
          }
          if (ctx.deliverySuccess) {
            const paths = ctx.filesTouched.slice(-salvaged.length);
            const answer =
              'Created project files in your workspace:\n\n' +
              paths.map((p) => '- `' + p + '`').join('\n') +
              '\n\nOpen them from the Files panel.';
            full += (full ? '\n\n' : '') + answer;
            emit({ type: 'text', text: answer, final: false, step: i + 1 });
            messages.push({ role: 'assistant', content: answer });
            messages.push({
              role: 'user',
              content:
                '[internal] Salvaged narrated files to disk. Call preview_project on the project path, fix errors, ' +
                'and meet acceptance tests before claiming done. Do not stop yet.',
            });
            toolSummaryParts.push('build_salvage → ' + paths.length + ' files');
            continue;
          }
        }
        messages.push({ role: 'assistant', content: finalStepText || '' });
        messages.push({
          role: 'user',
          content:
            '[internal] No workspace files were created yet (nudge ' +
            ctx._forcedDeliveryNudge +
            '). Your chat dump does NOT save files. ' +
            'Immediately emit a ```tool block calling write_file with FULL file contents under ' +
            '/home/user/projects/<slug>/ (only the files the user asked for — often a single index.html). ' +
            'Then list_directory. Do not invent Download links. Do not use Python open()/zipfile. Do not narrate.',
        });
        emit({ type: 'gate', step: i + 1, hidden: true, reason: 'missing_delivery' });
        await persistCheckpoint(threadId, {
          status: 'running',
          runId,
          step: i + 1,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed,
          usage: { ...usage },
          todos: ctx.todos,
          workflow,
          model: usage.model,
        });
        continue;
      }

      // Last step still empty: salvage or honest failure (never lie)
      if (
        shouldForceTools &&
        !ctx.deliverySuccess &&
        i >= iterations - 1
      ) {
        const salvaged = extractFilesFromNarration(
          (full || '') + '\n' + (finalStepText || ''),
        );
        if (salvaged.length) {
          const target = resolveProjectTarget(
            userMessage || (ctx.briefing && ctx.briefing.goal),
            ctx.briefing && ctx.briefing.goal,
            ctx.briefing,
          );
          const slug = target.slug;
          const root = target.root || '/home/user/projects/' + slug;
          for (let si = 0; si < salvaged.length; si++) {
            const f = salvaged[si];
            const path = root + '/' + f.relativePath.replace(/^\/+/, '');
            const result = await executeRemoteTool(
              {
                tool: 'write_file',
                params: { path: path, content: f.content },
                id: 'last_salvage_' + si,
              },
              ctx,
            );
            toolsUsed += 1;
            if (result && result.ok) {
              if (result.path) ctx.filesTouched.push(result.path);
              ctx.deliverySuccess = true;
            }
          }
        }
        if (!ctx.deliverySuccess) {
          const fail =
            'I could not write project files into the workspace. ' +
            'Nothing was saved under /home/user/projects/. Please try again (or check BYOK / model), ' +
            'or ask me to retry with write_file.';
          emit({ type: 'text', text: fail, final: true, step: i + 1 });
          return finishRun({
            threadId,
            model: usage.model,
            full: fail,
            usage: { ...usage },
            toolsUsed,
            steps: i + 1,
            emit,
            ctx,
        runLog,
        status: 'done',
          });
        }
        const paths = ctx.filesTouched.filter((p) =>
          String(p).indexOf('/home/user/projects/') === 0,
        );
        const answer =
          'Created project files in your workspace:\n\n' +
          (paths.length
            ? paths.map((p) => '- `' + p + '`').join('\n')
            : '- (see Files panel)') +
          '\n\nOpen them from the Files panel.';
        emit({ type: 'text', text: answer, final: true, step: i + 1 });
        return finishRun({
          threadId,
          model: usage.model,
          full: answer,
          usage: { ...usage },
          toolsUsed,
          steps: i + 1,
          emit,
          status: 'done',
          ctx,
          runLog,
        });
      }

      let gate = finishGate({
        state: workflow,
        todos: ctx.todos,
        step: i + 1,
        taskType: ctx.taskType || 'mixed',
        forcePlan: shouldForceTools,
        deliverySuccess: !!ctx.deliverySuccess,
        requirePlan: !!ctx.requirePlan,
        planPath: ctx.planPath || (ctx.blackboard && ctx.blackboard.planPath),
        previewOk: !!ctx.previewOk,
        previewFailed: !!ctx.previewFailed,
      });
      if (!gate) {
        gate = Delivery.enterpriseDoneGate(ctx, {
          forcePlan: shouldForceTools,
          acceptance: ctx.acceptanceTests,
        });
      }
      if (!gate) {
        const planNudge = PlanArtifact.missingPlanNudge(ctx);
        if (planNudge) {
          messages.push({ role: 'assistant', content: finalStepText || '' });
          messages.push({ role: 'user', content: planNudge });
          emit({ type: 'gate', step: i + 1, hidden: true, reason: 'need_plan' });
          continue;
        }
      }
      if (gate) {
        messages.push({ role: 'assistant', content: finalStepText || '' });
        messages.push({ role: 'user', content: gate });
        // Internal nudge only — never show gate text in the chat transcript.
        emit({ type: 'gate', step: i + 1, hidden: true });
        await persistCheckpoint(threadId, {
          status: 'running',
          runId,
          step: i + 1,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed,
          usage: { ...usage },
          todos: ctx.todos,
          workflow,
          model: usage.model,
        });
        continue;
      }

      const answer = full || cleaned || finalStepText;
      if (
        ['build', 'debug', 'mixed'].indexOf(String(ctx.taskType || '')) >= 0 &&
        ctx.deliverySuccess &&
        !ctx.previewOk &&
        i < iterations - 1
      ) {
        const slug =
          ctx.activeProject ||
          resolveProjectTarget(
            userMessage || (ctx.briefing && ctx.briefing.goal),
            ctx.briefing && ctx.briefing.goal,
            ctx.briefing,
          ).slug;
        const root = '/home/user/projects/' + slug;
        messages.push({ role: 'assistant', content: finalStepText || '' });
        messages.push({
          role: 'user',
          content:
            '[internal] Before finishing, call preview_project({path:"' +
            root +
            '"}) to open the live localhost preview and run debug. ' +
            'If errors are returned, fix them and re-run preview_project. Do not narrate.',
        });
        emit({ type: 'gate', step: i + 1, hidden: true, reason: 'need_preview' });
        await persistCheckpoint(threadId, {
          status: 'running',
          runId,
          step: i + 1,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed,
          usage: { ...usage },
          todos: ctx.todos,
          workflow,
          model: usage.model,
        });
        continue;
      }
      if (
        ctx.doneWhen &&
        artifactLooksDone(ctx.doneWhen, ctx) &&
        ctx.deliverySuccess &&
        (ctx.previewOk ||
          ['build', 'debug', 'mixed'].indexOf(String(ctx.taskType || '')) < 0)
      ) {
        if (ctx.blackboard) {
          const mon = TeamPipeline.monitorCheck(ctx, {
            toolsUsed,
            nearDone: true,
          });
          if (!mon.pass && mon.fix_brief && i < iterations - 1) {
            emit({ type: 'critique', critique: mon, team: true, phase: 'monitor' });
            messages.push({
              role: 'user',
              content:
                mon.fix_brief +
                '\n\n' +
                TeamPipeline.formatTeamPrompt(ctx.blackboard),
            });
            await persistCheckpoint(threadId, {
              status: 'running',
              runId,
              step: i + 1,
              maxSteps: iterations,
              messages: checkpointMessages(messages),
              fullText: full,
              toolsUsed,
              usage: { ...usage },
              todos: ctx.todos,
              workflow,
              blackboard: Blackboard.serialize(ctx.blackboard),
              model: usage.model,
            });
            continue;
          }
          TeamPipeline.setPhase(ctx.blackboard, 'critique', 'done_when candidate — critic next');
          emit(TeamPipeline.phaseEvent('critique', 'Self-check before finish'));
        }
        // Do not finish here for delivery tasks — critic must still pass.
        const lightDone =
          ['chat', 'question'].indexOf(String(ctx.taskType || '')) >= 0;
        if (lightDone) {
          const diag = buildRunDiagnostics({
            taskType: ctx.taskType,
            doneWhen: ctx.doneWhen,
            steps: i + 1,
            toolsUsed,
            deliverySuccess: true,
            consecutiveFails: ctx.consecutiveFails,
            stepsWithoutSuccess: ctx.stepsWithoutSuccess,
            filesTouched: ctx.filesTouched,
            stopReason: 'done_when_met',
            model: usage.model,
            workspaceFileCount: Object.keys(ctx.files || {}).length,
          });
          emit({ type: 'diagnostics', diagnostics: diag });
          return finishRun({
            threadId,
            model: usage.model,
            full: answer,
            usage: { ...usage, diagnostics: diag },
            toolsUsed,
            steps: i + 1,
            emit,
            status: 'done',
            ctx,
            runLog,
          });
        }
      }
      if (toolsUsed > 0 && ctx.briefing) {
        const critique = await runCriticPass({
          userMessage: (ctx.briefing && ctx.briefing.goal) || userMessage,
          briefing: ctx.briefing,
          answer,
          toolSummary: toolSummaryParts.join('\n'),
          model,
          userId,
          emit,
          ctx,
        });
        // Artifact-aware critic: fail if done_when not met in workspace
        if (
          critique.pass &&
          ctx.doneWhen &&
          !artifactLooksDone(ctx.doneWhen, ctx) &&
          ['document', 'build', 'debug', 'git'].indexOf(String(ctx.taskType)) >= 0
        ) {
          critique.pass = false;
          critique.gaps = (critique.gaps || []).concat([
            'done_when not evidenced in workspace: ' + ctx.doneWhen,
          ]);
          critique.fix_brief =
            critique.fix_brief ||
            'Deliver the missing workspace artifact now (create_pdf/create_document/write_file/verify), then stop.';
        }
        emit({ type: 'critique', critique });
        logEvent(runLog, 'critique', {
          pass: critique.pass,
          score: critique.score,
          role: critique.role,
        });
        const canRepairVerify =
          critique.role === 'verify' && verifyRepaired < 2 && i < iterations - 1;
        const canRepairPlan =
          critique.role !== 'verify' && criticRepaired < 2 && i < iterations - 1;
        if (!critique.pass && critique.fix_brief && (canRepairVerify || canRepairPlan)) {
          if (critique.role === 'verify') verifyRepaired += 1;
          else criticRepaired += 1;
          messages.push({ role: 'assistant', content: finalStepText || '' });
          messages.push({
            role: 'user',
            content:
              (critique.role === 'verify'
                ? 'Verify role found gaps (verify repair pass):\n'
                : 'Plan critic found gaps (plan repair pass):\n') +
              (critique.gaps || []).map((g) => '- ' + g).join('\n') +
              '\n\nFix brief:\n' +
              critique.fix_brief +
              '\n\n' +
              Blackboard.formatForPrompt(ctx.blackboard) +
              '\n\nWorkspace:\n' +
              workspaceInventory(ctx.files, { limit: 20 }).text +
              '\n\nContinue with tools' +
              (critique.role === 'verify'
                ? ' (preview_project or delegate_task agent=verify).'
                : ' against the approved plan.') +
              (verifyRepaired >= 2 && criticRepaired >= 2
                ? ' Then finish WITHOUT further critique loops.'
                : ''),
          });
          await persistCheckpoint(threadId, {
            status: 'running',
            runId,
            step: i + 1,
            maxSteps: iterations,
            messages: checkpointMessages(messages),
            fullText: full,
            toolsUsed,
            usage: { ...usage },
            todos: ctx.todos,
            workflow,
            criticRepaired,
            verifyRepaired,
            blackboard: Blackboard.serialize(ctx.blackboard),
            planPath: ctx.planPath,
            requirePlan: ctx.requirePlan,
            planApproved: ctx.planApproved,
            autoResumeCount,
            autonomy,
            model: usage.model,
          });
          continue;
        }
        // After repair budget is spent, reopen plan approval instead of shipping a failed build.
        if (
          !critique.pass &&
          ctx.requirePlan &&
          !canRepairVerify &&
          !canRepairPlan &&
          ['build', 'debug', 'git', 'mixed', 'run'].indexOf(
            String(ctx.taskType || ''),
          ) >= 0
        ) {
          const gaps = critique.gaps || [];
          const revised = Object.assign({}, ctx.briefing || {}, {
            understanding:
              (ctx.briefing && ctx.briefing.understanding) ||
              (ctx.briefing && ctx.briefing.goal) ||
              '',
            executor_brief:
              critique.fix_brief ||
              ((ctx.briefing && ctx.briefing.executor_brief) || ''),
            success_criteria: (
              (ctx.briefing && ctx.briefing.success_criteria) ||
              []
            ).concat(gaps).filter(Boolean),
            replan_reason: gaps.slice(0, 6).join('; ') || 'critic failed',
          });
          ctx.briefing = revised;
          ctx.planApproved = false;
          const plan = PlanArtifact.rewriteFromBriefing(
            ctx,
            revised,
            (ctx.briefing && ctx.briefing.goal) || userMessage,
          );
          if (plan && plan.path && workspaceId && ctx.files[plan.path]) {
            try {
              await persistFilePut(ctx, ctx.files[plan.path], {
                allowEmpty: true,
              });
            } catch {
              /* ignore */
            }
          }
          const parsed =
            (plan && plan.parsed) ||
            PlanArtifact.parsePlanArtifact(plan && plan.content);
          TeamPipeline.setPhase(
            ctx.blackboard,
            'plan',
            're-plan after critic failure',
          );
          await persistCheckpoint(threadId, {
            status: 'awaiting_plan',
            runId,
            step: i + 1,
            maxSteps: iterations,
            messages: checkpointMessages(messages),
            fullText: full,
            toolsUsed,
            usage: { ...usage },
            todos: ctx.todos,
            briefing: revised,
            userMessage:
              (existingRun && existingRun.userMessage) || userMessage,
            workflow,
            criticRepaired,
            verifyRepaired,
            blackboard: Blackboard.serialize(ctx.blackboard),
            planPath: plan && plan.path,
            requirePlan: true,
            planApproved: false,
            autoResumeCount,
            autonomy,
            model: usage.model,
          });
          emit({
            type: 'awaiting_plan',
            runId,
            briefing: revised,
            resume: true,
            autonomy,
            planPath: plan && plan.path,
            planMarkdown: plan && plan.content,
            planComplete: !!(parsed && parsed.complete),
            planErrors: (parsed && parsed.errors) || [],
            reason: 'Critic failed — revise and re-approve the plan',
            replan: true,
            critique,
          });
          logEvent(runLog, 'awaiting_plan_replan', {
            gaps: gaps.slice(0, 8),
          });
          return {
            response: full,
            steps: i + 1,
            usage: { ...usage, runId },
            status: 'awaiting_plan',
            runId,
            briefing: revised,
            planPath: plan && plan.path,
          };
        }
      }
      const diag = buildRunDiagnostics({
        taskType: ctx.taskType,
        doneWhen: ctx.doneWhen,
        steps: i + 1,
        toolsUsed,
        deliverySuccess: ctx.deliverySuccess,
        consecutiveFails: ctx.consecutiveFails,
        stepsWithoutSuccess: ctx.stepsWithoutSuccess,
        filesTouched: ctx.filesTouched,
        stopReason: 'complete',
        model: usage.model,
        workspaceFileCount: Object.keys(ctx.files || {}).length,
      });
      emit({ type: 'diagnostics', diagnostics: diag });
      emit({
        type: 'run_log',
        summary: summarizeLog(runLog),
      });
      return finishRun({
        threadId,
        model: usage.model,
        full: answer,
        usage: { ...usage, diagnostics: diag },
        toolsUsed,
        steps: i + 1,
        emit,
        status: 'done',
        ctx,
        runLog,
      });
    }

    messages.push({
      role: 'assistant',
      content: cleaned || finalStepText || null,
      tool_calls: tools.map((call) => {
        if (!call.id) {
          call.id = 'tc_' + Math.random().toString(36).slice(2, 8);
        }
        return {
          id: call.id,
          type: 'function',
          function: {
            name: call.tool,
            arguments: JSON.stringify(call.params || {}),
          },
        };
      }),
    });

    const results = [];
    for (const call of tools) {
      if (overBudget()) break;

      // Doom-loop gate: 3 identical tool+args in a row
      const doom = SelfAwareness.detectDoomLoop(ctx._toolFingerprints, call);
      if (doom.fingerprint) {
        SelfAwareness.pushDoomFingerprint(ctx, doom.fingerprint);
      }
      const toolFailDoom = SelfAwareness.detectRepeatedToolFails(
        ctx.lastFailures,
        call.tool,
        2,
      );
      if (doom.doom || toolFailDoom.doom) {
        const hint = (doom.doom && doom.hint) || toolFailDoom.hint;
        toolsUsed += 1;
        usage.toolsUsed = toolsUsed;
        const doomResult = {
          ok: false,
          tool: call.tool || 'invalid',
          invalid: true,
          doom_loop: true,
          error: hint,
          hint: hint,
          needs_approval: true,
          risk: 'always',
        };
        emit({
          type: 'tool_start',
          tool: call.tool,
          params: call.params,
          id: call.id,
          structured: !!call.structured,
        });
        results.push({
          tool: call.tool,
          params: call.params,
          result: doomResult,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.tool,
          content: JSON.stringify(doomResult),
        });
        emit({
          type: 'tool_result',
          tool: call.tool,
          id: call.id,
          result: doomResult,
        });
        messages.push({
          role: 'user',
          content:
            '<system-reminder>\n' +
            hint +
            '\nChange strategy before retrying.\n</system-reminder>',
        });
        continue;
      }

      toolsUsed += 1;
      usage.toolsUsed = toolsUsed;
      if (ctx.spendTracker) {
        ctx.spendTracker.add({
          promptTokens: promptTokens,
          completionTokens: completionTokens,
        });
      }
      emit({
        type: 'tool_start',
        tool: call.tool,
        params: call.params,
        id: call.id,
        structured: !!call.structured,
      });
      const result = await applySpillToResult(
        await executeRemoteTool(call, ctx),
        ctx,
        call.tool,
      );
      workflow = recordToolPhase(workflow, call.tool);
      if (result && result.path) {
        ctx.filesTouched.push(result.path);
      }
      if (result && result.spill_path) {
        ctx.filesTouched.push(result.spill_path);
      }
      if (call.tool === 'verify_project' && result && result.ok !== false) {
        ctx.verifiedAny = true;
      }
      if (call.tool === 'preview_project') {
        const preview = result && result.preview;
        if (preview) {
          emit({
            type: 'preview',
            preview: preview,
            errors: (result && result.errors) || [],
            warnings: (result && result.warnings) || [],
            ok: !!(result && result.ok),
            path: result.path,
            localhost: result.localhost || (preview && preview.url),
            port: result.port || (preview && preview.port),
          });
        }
        if (result && result.ok) {
          ctx.previewOk = true;
          ctx.previewFailed = false;
          ctx.verifiedAny = true;
          workflow.verified = true;
          workflow.previewFailed = false;
        } else {
          ctx.previewOk = false;
          ctx.previewFailed = true;
          workflow.verified = false;
          workflow.previewFailed = true;
        }
        if (ctx.blackboard) {
          Blackboard.setPreviewResult(ctx.blackboard, result);
          Blackboard.syncFromCtx(ctx.blackboard, ctx);
        }
      }
      if (call.tool === 'git_commit' && result && result.ok !== false) {
        ctx.gitCommitted = true;
      }
      if (call.tool === 'run_tests' && result) {
        ctx.testsOk = !!(result.testsOk || (result.ok && result.skipped));
        if (result.lastTest) ctx.lastTest = result.lastTest;
        if (result.lastDiagnostics) ctx.lastDiagnostics = result.lastDiagnostics;
        if (result.runConfigs) ctx.runConfigs = result.runConfigs;
        if (typeof ctx.emit === 'function') {
          ctx.emit({
            type: 'problems',
            problems:
              (ctx.lastDiagnostics && ctx.lastDiagnostics.problems) || [],
            lastDiagnostics: ctx.lastDiagnostics || null,
            testsOk: !!ctx.testsOk,
            lastTest: ctx.lastTest || null,
            runConfigs: ctx.runConfigs || null,
          });
        }
      }
      if (call.tool === 'repo_diagnostics' && result) {
        if (result.lastDiagnostics) ctx.lastDiagnostics = result.lastDiagnostics;
        if (result.runConfigs) ctx.runConfigs = result.runConfigs;
        if (typeof ctx.emit === 'function') {
          ctx.emit({
            type: 'problems',
            problems:
              (ctx.lastDiagnostics && ctx.lastDiagnostics.problems) || [],
            lastDiagnostics: ctx.lastDiagnostics || null,
            testsOk: !!ctx.testsOk,
            runConfigs: ctx.runConfigs || null,
          });
        }
      }
      if (
        (call.tool === 'git_clone' || call.tool === 'repo_open') &&
        result &&
        result.ok !== false &&
        result.repo
      ) {
        ctx.repo = result.repo;
      }
      if (isDeliverySuccess(call.tool, result)) {
        ctx.deliverySuccess = true;
        ctx.consecutiveFails = 0;
        ctx.stepsWithoutSuccess = 0;
      } else if (isProgressSuccess(call.tool, result)) {
        // preview/verify/shell progress — clears fail streak, not delivery
        ctx.consecutiveFails = 0;
      } else if (!isSuccessfulTool(call.tool, result)) {
        ctx.consecutiveFails += 1;
        ctx.lastFailures.push(
          call.tool + ': ' + String((result && result.error) || 'fail').slice(0, 160),
        );
        if (result && result.invent_path) {
          ctx.inventPathFails = (ctx.inventPathFails || 0) + 1;
        }
      }
      // Explore-only success (view_tree/search_code/find_files) must NOT reset
      // consecutiveFails — that hid invent-path loops behind empty greps.
      if (result && result.ok === false && result.error && !ctx.lastFailures.length) {
        ctx.lastFailures.push(call.tool + ': ' + String(result.error).slice(0, 160));
      }
      if (result && result.needs_approval) {
        await persistCheckpoint(threadId, {
          status: 'awaiting_approval',
          runId,
          step: i,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed: Math.max(0, toolsUsed - 1),
          usage: { ...usage, toolsUsed: Math.max(0, toolsUsed - 1) },
          todos: ctx.todos,
          workflow,
          pendingTool: call.tool,
          pendingParams: call.params || {},
          approvedTools: [...approvedTools],
          autoResumeCount,
          criticRepaired,
          autonomy,
          briefing: ctx.briefing,
          userMessage,
          model: usage.model,
        });
        emit({
          type: 'awaiting_approval',
          tool: call.tool,
          params: call.params,
          reason: result.error,
          resume: true,
          runId,
          autonomy,
        });
        return {
          response: result.error,
          steps: i + 1,
          usage,
          status: 'awaiting_approval',
          runId,
        };
      }
      if (call.tool === 'todo' && result && result.todos) {
        ctx.todos = result.todos;
        emit({ type: 'todos', todos: ctx.todos });
      }
      // Advance phase markers from tools
      if (ctx.blackboard) {
        if (
          (call.tool === 'delegate_task' ||
            call.tool === 'view_tree' ||
            call.tool === 'find_files' ||
            call.tool === 'search_code' ||
            call.tool === 'search_web') &&
          TeamPipeline.phaseIndex(ctx.blackboard.phase) <=
            TeamPipeline.phaseIndex('research')
        ) {
          /* stay/enter research */
          if (ctx.blackboard.phase !== 'research') {
            TeamPipeline.setPhase(ctx.blackboard, 'research', call.tool);
          }
        }
        if (
          isDeliverySuccess(call.tool, result) &&
          TeamPipeline.phaseIndex(ctx.blackboard.phase) <
            TeamPipeline.phaseIndex('execute')
        ) {
          TeamPipeline.setPhase(ctx.blackboard, 'execute', 'delivery via ' + call.tool);
          emit(TeamPipeline.phaseEvent('execute'));
        }
        if (call.tool === 'preview_project' && result && result.ok) {
          TeamPipeline.setPhase(ctx.blackboard, 'verify', 'preview ok');
          emit(TeamPipeline.phaseEvent('verify', 'Verify — preview passed'));
        }
        if (call.tool === 'delegate_task' && result && ctx.blackboard) {
          Blackboard.mergeDelegateResult(ctx.blackboard, result);
        }
      }
      // Periodic monitor (cheap, deterministic)
      if (
        TeamPipeline.shouldRunMonitor(ctx, toolsUsed, lastMonitorAt) &&
        ctx.blackboard
      ) {
        lastMonitorAt = toolsUsed;
        const mon = TeamPipeline.monitorCheck(ctx, {
          toolsUsed,
          nearDone: false,
        });
        emit({
          type: 'critique',
          critique: mon,
          team: true,
          phase: 'monitor',
        });
        emit(
          TeamPipeline.phaseEvent(
            'monitor',
            mon.pass
              ? 'Monitor — on course'
              : 'Monitor — course correction',
          ),
        );
        if (!Array.isArray(ctx.blackboard.monitorNotes)) {
          ctx.blackboard.monitorNotes = [];
        }
        ctx.blackboard.monitorNotes.push({
          at: new Date().toISOString(),
          pass: mon.pass,
          gaps: mon.gaps,
          fix_brief: mon.fix_brief,
        });
        ctx.blackboard.monitorNotes = ctx.blackboard.monitorNotes.slice(-12);
        if (!mon.pass && mon.fix_brief) {
          messages.push({
            role: 'user',
            content:
              mon.fix_brief +
              '\n\n' +
              TeamPipeline.formatTeamPrompt(ctx.blackboard) +
              '\n\n' +
              Blackboard.formatForPrompt(ctx.blackboard),
          });
          TeamPipeline.setPhase(ctx.blackboard, 'execute', 'monitor nudge');
        }
      }
      if (result && result.action_trace) {
        emit({ type: 'action_trace', trace: result.action_trace, tool: call.tool });
        logEvent(runLog, 'action_trace', {
          tool: call.tool,
          url: result.action_trace.url,
        });
      }
      if (result && result.health) {
        emit({
          type: 'browser_health',
          health: result.health,
          step: i + 1,
          remainingSteps: Math.max(0, iterations - (i + 1)),
        });
      }
      // Auto-pause on login/CAPTCHA walls
      if (
        result &&
        result.health &&
        (result.health.needs_user_auth ||
          result.health.captcha_likely ||
          result.health.otp_likely)
      ) {
        const reason =
          'Browser needs your login / 2FA / CAPTCHA. Finish it in the cloud browser, then click Resume.';
        await persistCheckpoint(threadId, {
          status: 'awaiting_login',
          runId,
          step: i + 1,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed,
          usage: { ...usage },
          todos: ctx.todos,
          workflow,
          model: usage.model,
          briefing: ctx.briefing,
          userMessage,
          toolSummaryParts,
        });
        emit({
          type: 'awaiting_login',
          reason,
          health: result.health,
          resume: true,
          runId,
        });
        return {
          response: reason,
          steps: i + 1,
          usage,
          status: 'awaiting_login',
          runId,
        };
      }
      if (result && result.await_login) {
        const reason = result.reason || 'Complete login, then resume.';
        await persistCheckpoint(threadId, {
          status: 'awaiting_login',
          runId,
          step: i + 1,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed,
          usage: { ...usage },
          todos: ctx.todos,
          workflow,
          model: usage.model,
          briefing: ctx.briefing,
          userMessage,
          toolSummaryParts,
        });
        emit({
          type: 'awaiting_login',
          reason,
          resume: true,
          runId,
        });
        return {
          response: reason,
          steps: i + 1,
          usage,
          status: 'awaiting_login',
          runId,
        };
      }
      if (result && (result.await_clarify || result.type === 'user_input')) {
        const reason =
          result.question || result.text || 'Waiting for your choice to continue.';
        await persistCheckpoint(threadId, {
          status: 'awaiting_clarify',
          runId,
          step: i + 1,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed,
          usage: { ...usage },
          todos: ctx.todos,
          workflow,
          model: usage.model,
          briefing: ctx.briefing,
          userMessage,
          toolSummaryParts,
          clarify: {
            question: result.question,
            options: result.options,
            questions: result.questions,
          },
        });
        emit({
          type: 'awaiting_clarify',
          question: result.question,
          options: result.options,
          questions: result.questions,
          reason,
          resume: true,
          runId,
        });
        return {
          response: reason,
          steps: i + 1,
          usage,
          status: 'awaiting_clarify',
          runId,
          userInput: result,
        };
      }
      if (
        result &&
        (result.needs_input || result.await_shell_input) &&
        call.tool !== 'shell_read'
      ) {
        const reason =
          result.reason ||
          'Shell is waiting for interactive input (password/confirm). Provide it and resume, or use shell_write.';
        await persistCheckpoint(threadId, {
          status: 'awaiting_shell',
          runId,
          step: i + 1,
          maxSteps: iterations,
          messages: checkpointMessages(messages),
          fullText: full,
          toolsUsed,
          usage: { ...usage },
          todos: ctx.todos,
          workflow,
          model: usage.model,
          briefing: ctx.briefing,
          userMessage,
          toolSummaryParts,
          lastCommand: result.command || (call.params && call.params.cmd),
        });
        emit({
          type: 'awaiting_shell',
          reason,
          command: result.command,
          output: (result.output || '').slice(-2000),
          resume: true,
          runId,
        });
        return {
          response: reason,
          steps: i + 1,
          usage,
          status: 'awaiting_shell',
          runId,
        };
      }
      if (result && Array.isArray(result.downloads) && result.downloads.length) {
        emit({
          type: 'download_detected',
          downloads: result.downloads,
          needs_confirmation: true,
        });
        messages.push({
          role: 'user',
          content:
            'Download(s) detected:\n' +
            result.downloads
              .map((d) => '- ' + (d.url || '') + ' (' + (d.content_type || '') + ')')
              .join('\n') +
            '\nDo not save until the user confirms filename/source. Ask with <confirmation>.',
        });
      }
      results.push({
        tool: call.tool,
        params: call.params,
        result: shrinkToolResult(result, TOOL_RESULT_SOFT_LIMIT),
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.tool,
        content: JSON.stringify(shrinkToolResult(result, TOOL_RESULT_SOFT_LIMIT)),
      });
      emit({
        type: 'tool_result',
        tool: call.tool,
        id: call.id,
        result: shrinkToolResult(result, TOOL_RESULT_SOFT_LIMIT),
      });
      emit({
        type: 'budget',
        maxSteps: iterations,
        remainingSteps: Math.max(0, iterations - (i + 1)),
        budgetMs: budget,
        elapsedMs: Date.now() - startedAt,
      });
      toolSummaryParts.push(
        call.tool +
          ': ' +
          (result && result.ok === false
            ? 'FAIL ' + (result.error || '')
            : 'ok') +
          (result && result.path ? ' → ' + result.path : '') +
          (result && result.vision_caption
            ? ' | vision: ' + String(result.vision_caption).slice(0, 200)
            : ''),
      );
      logEvent(runLog, 'tool', {
        tool: call.tool,
        ok: !(result && result.ok === false),
      });

      // Checkpoint after each tool
      await persistCheckpoint(threadId, {
        status: 'running',
        runId,
        step: i + 1,
        maxSteps: iterations,
        messages: checkpointMessages(messages),
        fullText: full,
        toolsUsed,
        usage: { ...usage },
        todos: ctx.todos,
        workflow,
        lastTool: call.tool,
        filesTouched: ctx.filesTouched,
        model: usage.model,
      });
    }

    if (!ctx.deliverySuccess) ctx.stepsWithoutSuccess += 1;
    else ctx.stepsWithoutSuccess = 0;

    const early = checkEarlyStop({
      consecutiveFails: ctx.consecutiveFails,
      stepsWithoutSuccess: ctx.stepsWithoutSuccess,
      taskType: ctx.taskType,
    });
    if (early) {
      const stopMsg =
        '<answer>\n' +
        early.message +
        '\n\nLast failures:\n' +
        (ctx.lastFailures || []).slice(-3).map((f) => '- ' + f).join('\n') +
        '\n\n' +
        workspaceInventory(ctx.files, { limit: 12 }).text +
        '\n\nDo not claim success. Fix using inventory paths only, then continue.\n</answer>';
      const diag = buildRunDiagnostics({
        taskType: ctx.taskType,
        doneWhen: ctx.doneWhen,
        steps: i + 1,
        toolsUsed,
        deliverySuccess: false,
        consecutiveFails: ctx.consecutiveFails,
        stepsWithoutSuccess: ctx.stepsWithoutSuccess,
        filesTouched: ctx.filesTouched,
        stopReason: early.reason,
        model: usage.model,
        workspaceFileCount: Object.keys(ctx.files || {}).length,
      });
      emit({ type: 'diagnostics', diagnostics: diag });
      // Replace prior narration — do not append stop text under a fake success essay.
      full = cleanText(stopMsg);
      ctx.deliverySuccess = false;
      ctx.previewOk = false;
      ctx._earlyStopReason = early.reason;
      return finishRun({
        threadId,
        model: usage.model,
        full,
        usage: { ...usage, diagnostics: diag },
        toolsUsed,
        steps: i + 1,
        emit,
        status: 'failed',
        ctx,
        runLog,
        stopReason: early.reason,
      });
    }

    if (overBudget()) {
      const summarized = summarizeToolResults(results);
      if (results.length) {
        messages.push({
          role: 'user',
          content:
            'Tool execution results (summarized if large):\n' +
            JSON.stringify(summarized, null, 2) +
            '\n\nContinue when resumed.',
        });
      }
      if (tryAutoExtend('time_budget', i + 1)) {
        continue;
      }
      await persistCheckpoint(threadId, {
        status: 'interrupted',
        runId,
        step: i + 1,
        maxSteps: iterations,
        messages: checkpointMessages(messages),
        fullText: full,
        toolsUsed,
        usage: { ...usage, toolsUsed },
        reason: 'time_budget',
        autoResumeCount,
        criticRepaired,
        approvedTools: [...approvedTools],
        filesTouched: ctx.filesTouched,
        lastFailures: ctx.lastFailures,
        autonomy,
        model: usage.model,
      });
      emit({
        type: 'interrupted',
        runId,
        step: i + 1,
        reason: 'time_budget',
        resume: true,
        usage: { ...usage, toolsUsed },
        response: full || '(interrupted — resume to continue)',
      });
      return {
        response: full,
        steps: i + 1,
        usage: { ...usage, toolsUsed },
        status: 'interrupted',
        runId,
      };
    }

    const summarized = summarizeToolResults(results);
    // Sync blackboard from live ctx before status snapshot
    if (ctx.blackboard) {
      Blackboard.syncFromCtx(ctx.blackboard, ctx);
    }
    const statusBlock = SelfAwareness.formatStatusSnapshot(ctx, {
      workflow,
      step: i + 1,
      maxSteps: iterations,
      toolsUsed,
    });
    const bbBlock = Blackboard.formatForPrompt(ctx.blackboard, 2200);
    const skillRefresh =
      i > 0 && i % 4 === 0
        ? '\n\n' +
          skillCatalogBrief(
            (ctx.blackboard && ctx.blackboard.skillsNeeded) ||
              (ctx.briefing && ctx.briefing.skills) ||
              [],
            1200,
          )
        : '';
    const feed =
      statusBlock +
      '\n\n' +
      bbBlock +
      '\n\n' +
      workspaceInventory(ctx.files, { limit: 16 }).text +
      skillRefresh +
      (results.length
        ? '\n\nRecent tool results (compact):\n' +
          JSON.stringify(summarized, null, 2).slice(0, 6000)
        : '');
    messages.push({ role: 'user', content: feed });
    promptTokens += estimateTokens(feed);
    usage.promptTokensEst = promptTokens;
    usage.totalTokensEst = promptTokens + completionTokens;

    await persistCheckpoint(threadId, {
      status: 'running',
      runId,
      step: i + 1,
      maxSteps: iterations,
      messages: checkpointMessages(messages),
      fullText: full,
      toolsUsed,
      usage: { ...usage },
      todos: ctx.todos,
      workflow,
      model: usage.model,
    });
  }

  const msg = 'Reached max agent steps (' + iterations + ').';
  if (tryAutoExtend('max_steps', iterations)) {
    // One more burst — fall through by restarting loop boundary via recursive-ish continue isn't possible;
    // inject memory and run a short closing chat step instead.
    let closing = '';
    try {
      closing = await chatWorkerStreaming({
        messages: trimMessages(
          messages.concat([
            {
              role: 'user',
              content:
                '[internal] Steps exhausted after auto-extend. Give the best final summary of progress and remaining work WITHOUT tools.',
            },
          ]),
        ),
        model,
        userId,
        maxTokens: 1024,
        agent: true,
        onToken: (delta) => {
          closing += delta;
          emit({ type: 'token', text: delta });
        },
      });
    } catch (err) {
      closing = msg;
    }
    full += (full ? '\n\n' : '') + cleanText(closing || msg);
    return finishRun({
      threadId,
      model: usage.model,
      full,
      usage,
      toolsUsed,
      steps: iterations,
      emit,
      ctx,
        runLog,
        status: 'done',
    });
  }
  full += (full ? '\n\n' : '') + msg;
  return finishRun({
    threadId,
    model: usage.model,
    full,
    usage,
    toolsUsed,
    steps: iterations,
    emit,
    ctx,
        runLog,
        status: 'done',
  });
}

module.exports = {
  runAgentLoop,
  parseToolCalls,
  executeRemoteTool,
  parseMarkdownToolCalls,
};
