'use strict';

const {
  chatWorker,
  chatWorkerStreaming,
  chatWorkerWithTools,
  estimateTokens,
  affordableTokensFromError,
  isCreditError,
} = require('./llm');
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
} = require('./threads');
const {
  detectSkills,
  SKILL_GUIDES,
  composeActiveSkills,
  DESIGN_DOC_HINT,
  designTemplateBlock,
  expandSkillGuide,
} = require('./skills');
const {
  TOKEN_BUDGETS,
  deriveDoneWhen,
  workspaceInventory,
  isSuccessfulTool,
  isDeliverySuccess,
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
  extractFilesFromNarration,
  looksLikeFakeDeliveryClaim,
  buildFilesPrompt,
  parseGeneratedFiles,
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
const { newId } = require('./http');
const {
  resolveWorkspacePath,
  ensureParentDirs,
  toolParamsLookValid,
  validateToolCall,
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
} = require('./analyst');
const { assertToolAllowed } = require('./allowlists');
const { subagentPrompt, taskTypeBiasFor } = require('./subagents');
const {
  normalizeAutonomy,
  shouldAwaitPlan,
  toolNeedsApproval,
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

function parseMarkdownToolCalls(text) {
  const results = [];
  const blockRe = /```(?:tool|tool_call|agent|json)\s*\n?([\s\S]*?)```/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) {
        parsed.forEach((item) => {
          const n = normalizeToolCall(item);
          if (n) results.push(n);
        });
      } else if (parsed && parsed.tool_calls) {
        parsed.tool_calls.forEach((item) => {
          const n = normalizeToolCall(item);
          if (n) results.push(n);
        });
      } else {
        const n = normalizeToolCall(parsed);
        if (n) results.push(n);
      }
    } catch {
      /* ignore */
    }
  }
  if (results.length) return results;

  // Brace-balanced recovery for bare tool JSON (BYOK models often skip fences)
  const raw = String(text || '');
  const needles = ['{"tool"', '{ "tool"', '{"type":"function"', '{ "type": "function"', '{"name"', '{ "name"'];
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
        const n = normalizeToolCall(JSON.parse(raw.slice(at, end + 1)));
        if (n) results.push(n);
      } catch {
        /* ignore */
      }
      i = end + 1;
    } else {
      i = at + 1;
    }
  }
  return results;
}

function parseToolCalls(text, structuredCalls) {
  const fromNative = (structuredCalls || [])
    .map(normalizeToolCall)
    .filter(Boolean);
  const validNative = fromNative.filter(
    (c) => !c.parseFailed && toolParamsLookValid(c),
  );
  const invalidNative = fromNative.filter(
    (c) => c.parseFailed || !toolParamsLookValid(c),
  );
  // Prefer valid native calls; keep invalid siblings so execute can hard-fail with hints
  if (validNative.length) return validNative.concat(invalidNative);

  const fromMarkdown = parseMarkdownToolCalls(text);
  if (fromMarkdown.length) return fromMarkdown;

  // Last resort: surface native (even empty/malformed) for hard-fail feedback
  return fromNative;
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
  // Cap stored checkpoint size
  return trimMessages(messages).map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content.slice(0, 12000)
        : JSON.stringify(m.content).slice(0, 12000),
  }));
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
      return { ok: false, tool, error: 'No such file: ' + resolved.path };
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
      return { ok: false, tool, error: 'No such file: ' + resolved.path };
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
    return {
      ok: true,
      tool,
      path: resolved.path,
      replacements: patched.replacements || 1,
      text: 'Patched ' + resolved.path,
      revision: put.revision,
      previous: prev,
    };
  }

  if (tool === 'csv_read') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const f = ctx.files[resolved.path];
    if (!f || f.type !== 'file') {
      return { ok: false, tool, error: 'No such file: ' + resolved.path };
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
      return { ok: false, tool, error: 'No such file: ' + resolved.path };
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
        content = String(p.content);
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
    return {
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
    };
  }

  if (tool === 'read_file') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    const f = ctx.files[resolved.path];
    if (!f || f.type !== 'file') {
      return { ok: false, tool, error: 'No such file: ' + resolved.path };
    }
    return { ok: true, tool, path: resolved.path, content: f.content || '' };
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
      : { ok: true, path: '/' };
    if (!scope.ok) return { ok: false, tool, error: scope.error };
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
    };
  }

  if (tool === 'git_init') {
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
    return { ok: true, tool, output: JSON.stringify(ctx.git || {}, null, 2) };
  }

  if (tool === 'git_log') {
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
}) {
  const finalUsage = { ...usage, toolsUsed, steps };
  let proof = null;
  if (status === 'done' && ctx) {
    proof = Delivery.buildDoneProof(ctx, {
      previewUrl:
        (ctx.blackboard && ctx.blackboard.lastPreviewPath) ||
        null,
    });
    finalUsage.proof = proof;
    finalUsage.spend = ctx.spendTracker ? ctx.spendTracker.snapshot() : undefined;
  }
  if (status === 'done') {
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
      meta: redactValue({ usage: finalUsage, proof }),
    });
    await recordUsage(threadId, finalUsage, model);
    await saveAgentRun(threadId, {
      status: 'done',
      runId: usage.runId,
      step: steps,
      proof,
      auditSummary: audit && audit.summary,
      audit,
      updatedAt: new Date().toISOString(),
    });
    safeEmit(emit, {
      type: 'done',
      response: full,
      steps,
      usage: finalUsage,
      proof,
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
    planC = {
      pass: true,
      score: 50,
      gaps: [
        'critic unavailable: ' +
          (err instanceof Error ? err.message : String(err)),
      ],
      fix_brief: '',
      role: 'plan',
    };
  }

  return mergeCritiques(verifyC, planC);
}

async function runAgentLoop({
  threadId,
  workspaceId,
  userMessage,
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
}) {
  const autonomy = normalizeAutonomy(autonomyOpt || 'assist');
  const customAgents = Array.isArray(customAgentsOpt) ? customAgentsOpt : [];
  const thoroughness = thoroughnessOpt || 'medium';
  const composerMode = String(composerModeOpt || '').toLowerCase();
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
  let criticRepaired = !!(existingRun && existingRun.criticRepaired);
  let verifyRepaired = !!(existingRun && existingRun.verifyRepaired);
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
        normalizeBriefing(briefingOverride, um),
        um,
      );
      ctx.taskType = ctx.briefing.task_type;
    }

    const doPlanHandoff =
      approvePlan === true ||
      existingRun.status === 'awaiting_plan';

    if (doPlanHandoff && ctx.briefing) {
      const um = existingRun.userMessage || userMessage || '';
      ctx.briefing = enrichBriefing(ctx.briefing, um);
      ctx.taskType = ctx.briefing.task_type || ctx.taskType;
      // Forced plan → build handoff
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
      ctx.planApproved = true;
      ctx.requirePlan = true;
      const plan = PlanArtifact.ensureFromBriefing(ctx, ctx.briefing, um);
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
    emit({ type: 'phase', phase: 'analyze', text: 'Analyzing request…' });
    let briefing = null;
    try {
      const analysis = await chatWorker({
        messages: [
          {
            role: 'user',
            content: analystUserPrompt(
              userMessage,
              historySnippet(messages.slice(0, -1)),
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
      briefing = normalizeBriefing(extractJsonObject(analysisText), userMessage);
    } catch (err) {
      emit({
        type: 'phase',
        phase: 'analyze_error',
        text: err instanceof Error ? err.message : String(err),
      });
      briefing = normalizeBriefing(null, userMessage);
      briefing.understanding = 'Fallback: execute the user request directly.';
      briefing.task_type = autoSkills.length ? 'mixed' : 'question';
      briefing.executor_brief =
        'Complete the user request thoroughly using whatever tools fit. ' +
        'Do not follow a generic template — match the work to the request.';
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
      });
    }
    briefing = enrichBriefing(briefing, userMessage);

    // Re-pick skill from final task_type (+ design companion when relevant)
    const primarySkills = composeActiveSkills(
      autoSkillsAll,
      briefing.task_type,
      userMessage,
    );
    emit({ type: 'skills', skills: primarySkills });
    briefing.done_when = deriveDoneWhen(
      briefing,
      userMessage,
      briefing.task_type,
    );
    ctx.doneWhen = briefing.done_when;

    emit({
      type: 'analysis',
      briefing: {
        understanding: briefing.understanding,
        goal: briefing.goal,
        task_type: briefing.task_type,
        success_criteria: briefing.success_criteria,
        done_when: briefing.done_when,
        approach: briefing.approach,
        tools_priority: briefing.tools_priority,
        do_not: briefing.do_not,
        constraints: briefing.constraints,
        executor_brief: briefing.executor_brief,
        max_steps: briefing.max_steps,
        todos: briefing.todos,
      },
    });
    logEvent(runLog, 'analysis', {
      task_type: briefing.task_type,
      goal: briefing.goal,
      done_when: briefing.done_when,
    });

    const isLightEarly =
      briefing.task_type === 'chat' ||
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

    // Pause for plan approval when autonomy policy requires it
    const awaitPlan =
      !skipPlanApproval &&
      approvePlan !== true &&
      shouldAwaitPlan(autonomy, briefing.task_type, isLightEarly);

    if (awaitPlan) {
      const plan = PlanArtifact.ensureFromBriefing(ctx, briefing, userMessage);
      if (plan && plan.path && workspaceId && ctx.files[plan.path]) {
        try {
          await persistFilePut(ctx, ctx.files[plan.path], { allowEmpty: true });
        } catch {
          /* ignore */
        }
      }
      ctx.planPath = plan.path;
      ctx.blackboard = Blackboard.createBlackboard(
        Object.assign({}, ctx.blackboard || {}, {
          goal: briefing.goal,
          doneWhen: briefing.done_when,
          planPath: plan.path,
          todos: briefing.todos || [],
          requirePlan: true,
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
      });
      logEvent(runLog, 'awaiting_plan', { autonomy, planPath: plan.path });
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

    if (briefing.needs_clarification && briefing.clarification_question) {
      const q = briefing.clarification_question;
      await appendMessage(threadId, { role: 'assistant', content: q });
      emit({ type: 'done', response: q, steps: 0, usage: { runId }, clarification: true });
      return {
        response: q,
        steps: 0,
        usage: { runId },
        status: 'clarification',
        runId,
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

    const skillLines = primarySkills.length
      ? primarySkills.map((n) => SKILL_GUIDES[n] || n).join('\n')
      : '';
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
        (skillLines ? '\n\n# Skill playbooks\n' + skillLines : '') +
        (designExtra || '') +
        '\n\n# Playbook\n' +
        playbookForTaskType(briefing.task_type) +
        '\n' +
        workspacePlaybookExtra(briefing.task_type) +
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
        buildRunMemoryPack({
          goal: briefing.goal,
          taskType: briefing.task_type,
          todos: briefing.todos,
          workflow,
          autonomy,
        }),
    });

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

    // HTML/CSS/JS (and similar) builds: generate + write_file server-side so
    // the model cannot "narrate" files that never land in the workspace.
    if (shouldBuildFastPath(briefing, userMessage) && !isLight && !(ctx.agentInfo && (ctx.agentInfo.name === 'plan' || ctx.agentInfo.name === 'explore'))) {
      emit({
        type: 'phase',
        phase: 'execute',
        text: 'Generating project files…',
      });
      const slug = projectSlug(userMessage, briefing.goal);
      let genText = '';
      const buildBudget = Math.min(
        Math.max(TOKEN_BUDGETS.document_body || 1800, 1800),
        2200,
      );
      try {
        genText = await chatWorkerStreaming({
          messages: trimMessages([
            {
              role: 'user',
              content: buildFilesPrompt(userMessage, briefing.goal, slug),
            },
          ]),
          model,
          userId,
          maxTokens: buildBudget,
          agent: false,
          onToken: (delta) => {
            // Buffer silently — do not stream JSON/prose into the chat as if
            // the agent were "Writing files…" in narration.
            genText += delta;
          },
        });
      } catch (err) {
        if (isCreditError(err)) {
          const afford = affordableTokensFromError(err);
          const retryBudget = Math.max(64, Math.min(900, (afford || 256) - 24));
          emit({
            type: 'phase',
            phase: 'execute',
            text:
              'Generation budget limited by API credits; retrying smaller…',
          });
          try {
            genText = await chatWorkerStreaming({
              messages: trimMessages([
                {
                  role: 'user',
                  content: buildFilesPrompt(userMessage, briefing.goal, slug),
                },
              ]),
              model,
              userId,
              maxTokens: retryBudget,
              agent: false,
              onToken: (delta) => {
                genText += delta;
              },
            });
          } catch (err2) {
            genText = '';
            emit({
              type: 'phase',
              phase: 'execute',
              text:
                'LLM generation unavailable (credits) — writing a playable scaffold…',
            });
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
        parsed = scaffoldHtmlProject(slug, userMessage, briefing.goal);
        emit({
          type: 'phase',
          phase: 'execute',
          text: 'Using built-in playable scaffold (LLM output missing/invalid)…',
        });
      }
      const useSlug = parsed.slug || slug;
      const root = '/home/user/projects/' + useSlug;
      ensureProject(ctx, useSlug, {
        goal: briefing.goal || userMessage,
        stack: 'html,css,js',
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
          const diag = buildRunDiagnostics({
            taskType: briefing.task_type,
            doneWhen: ctx.doneWhen,
            steps: 1,
            toolsUsed,
            deliverySuccess: true,
            filesTouched: ctx.filesTouched,
            stopReason: 'build_fast_path_preview_ok',
            primarySkill: primarySkills[0] || null,
            model,
            workspaceFileCount: Object.keys(ctx.files || {}).length,
          });
          emit({ type: 'diagnostics', diagnostics: diag });
          return finishRun({
            threadId,
            model: model || (thr && thr.model) || 'default',
            full: cleanText(answer),
            usage: { runId, model, toolsUsed, steps: 1, diagnostics: diag },
            toolsUsed,
            steps: 1,
            emit,
            ctx,
        runLog,
        status: 'done',
          });
        }
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
      const diag = buildRunDiagnostics({
        taskType: briefing.task_type,
        doneWhen: ctx.doneWhen,
        steps: 1,
        toolsUsed: 0,
        deliverySuccess: false,
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
    } catch (e) {
      if (isCreditError(e)) {
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

    const tools = parseToolCalls(finalStepText, structuredCalls);
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
          const slug = projectSlug(
            userMessage || (ctx.briefing && ctx.briefing.goal),
            ctx.briefing && ctx.briefing.goal,
          );
          const root = '/home/user/projects/' + slug;
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
            emit({ type: 'text', text: answer, final: true, step: i + 1 });
            const diag = buildRunDiagnostics({
              taskType: ctx.taskType,
              doneWhen: ctx.doneWhen,
              steps: i + 1,
              toolsUsed,
              deliverySuccess: true,
              filesTouched: ctx.filesTouched,
              stopReason: 'build_salvage',
              model: usage.model,
              workspaceFileCount: Object.keys(ctx.files || {}).length,
            });
            emit({ type: 'diagnostics', diagnostics: diag });
            return finishRun({
              threadId,
              model: usage.model,
              full,
              usage: { ...usage, diagnostics: diag },
              toolsUsed,
              steps: i + 1,
              emit,
              ctx,
        runLog,
        status: 'done',
            });
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
            '/home/user/projects/<slug>/index.html (and style.css, script.js). ' +
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
          const slug = projectSlug(
            userMessage || (ctx.briefing && ctx.briefing.goal),
            ctx.briefing && ctx.briefing.goal,
          );
          const root = '/home/user/projects/' + slug;
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
          projectSlug(
            userMessage || (ctx.briefing && ctx.briefing.goal),
            ctx.briefing && ctx.briefing.goal,
          );
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
          TeamPipeline.setPhase(ctx.blackboard, 'done', 'done_when met');
          emit(TeamPipeline.phaseEvent('done', 'Done'));
        }
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
          critique.role === 'verify' && !verifyRepaired && i < iterations - 1;
        const canRepairPlan =
          critique.role !== 'verify' && !criticRepaired && i < iterations - 1;
        if (!critique.pass && critique.fix_brief && (canRepairVerify || canRepairPlan)) {
          if (critique.role === 'verify') verifyRepaired = true;
          else criticRepaired = true;
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
              (verifyRepaired && criticRepaired
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
      content: finalStepText || JSON.stringify({ tool_calls: structuredCalls }),
    });

    const results = [];
    for (const call of tools) {
      if (overBudget()) break;
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
      if (isDeliverySuccess(call.tool, result)) {
        ctx.deliverySuccess = true;
        ctx.consecutiveFails = 0;
        ctx.stepsWithoutSuccess = 0;
      } else if (!isSuccessfulTool(call.tool, result)) {
        ctx.consecutiveFails += 1;
        ctx.lastFailures.push(
          call.tool + ': ' + String((result && result.error) || 'fail').slice(0, 160),
        );
      } else {
        ctx.consecutiveFails = 0;
      }
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
        '\n</answer>';
      const diag = buildRunDiagnostics({
        taskType: ctx.taskType,
        doneWhen: ctx.doneWhen,
        steps: i + 1,
        toolsUsed,
        deliverySuccess: ctx.deliverySuccess,
        consecutiveFails: ctx.consecutiveFails,
        stepsWithoutSuccess: ctx.stepsWithoutSuccess,
        filesTouched: ctx.filesTouched,
        stopReason: early.reason,
        model: usage.model,
        workspaceFileCount: Object.keys(ctx.files || {}).length,
      });
      emit({ type: 'diagnostics', diagnostics: diag });
      full += (full ? '\n\n' : '') + cleanText(stopMsg);
      return finishRun({
        threadId,
        model: usage.model,
        full: cleanText(full),
        usage: { ...usage, diagnostics: diag },
        toolsUsed,
        steps: i + 1,
        emit,
        status: 'done',
        ctx,
        runLog,
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
    const feed =
      'Tool execution results (summarized if large):\n' +
      JSON.stringify(summarized, null, 2) +
      '\n\nstatus: explored=' +
      workflow.explored +
      ' planned=' +
      workflow.planned +
      ' implemented=' +
      workflow.implemented +
      ' verified=' +
      workflow.verified +
      '\nTodos:\n' +
      (ctx.todos && ctx.todos.length
        ? ctx.todos
            .map(
              (t) =>
                (t.status === 'done' ? '[x] ' : '[ ] ') + t.id + ': ' + t.content,
            )
            .join('\n')
        : '(none — set todos if work remains)') +
      '\n\nContinue. Mark todos done. Prefer workspace delivery tools. Verify done_when before final summary WITHOUT tools.\n' +
      (ctx.doneWhen ? 'done_when: ' + ctx.doneWhen + '\n' : '') +
      workspaceInventory(ctx.files, { limit: 16 }).text;
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
