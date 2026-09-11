'use strict';

const {
  chatWorkerStreaming,
  chatWorkerWithTools,
  estimateTokens,
} = require('./llm');
const { TOOL_DEFS, normalizeToolCall } = require('./tool-defs');
const { listFiles, getWorkspace, saveSnapshot, putFile, deleteFile } = require('./workspace');
const { runInTempWorkspace } = require('./shell');
const { runInVercelSandbox } = require('./sandbox');
const {
  appendMessage,
  recordUsage,
  saveAgentRun,
  getThread,
} = require('./threads');
const { detectSkills, skillBrief, SKILL_GUIDES } = require('./skills');
const { newId } = require('./http');
const {
  resolveWorkspacePath,
  ensureParentDirs,
  toolParamsLookValid,
} = require('./paths');
const {
  workflowBrief,
  applyTodoAction,
  recordToolPhase,
  finishGate,
  emptyTodos,
} = require('./workflow');

const TOOL_RESULT_SOFT_LIMIT = 1800;
const CONTEXT_SOFT_LIMIT = 6500;
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
  return results;
}

function parseToolCalls(text, structuredCalls) {
  const fromNative = (structuredCalls || [])
    .map(normalizeToolCall)
    .filter(Boolean);
  const validNative = fromNative.filter(
    (c) => !c.parseFailed && toolParamsLookValid(c),
  );
  if (validNative.length) return validNative;

  const fromMarkdown = parseMarkdownToolCalls(text);
  if (fromMarkdown.length) return fromMarkdown;

  // Last resort: keep native even if params look empty (surface errors in tools)
  return fromNative;
}

function cleanText(text) {
  return String(text || '')
    .replace(/```(?:tool|tool_call|agent|json)\s*\n?[\s\S]*?```/g, '')
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

async function runCommand(ctx, cmd, cwd) {
  if (process.env.USE_VERCEL_SANDBOX === '1') {
    try {
      const sand = await runInVercelSandbox({
        files: ctx.files,
        cwd: cwd || ctx.cwd,
        command: cmd,
        timeoutMs: 90000,
      });
      if (sand && !sand.skipped) {
        if (sand.files) {
          ctx.files = sand.files;
          ctx.cwd = sand.cwd || ctx.cwd;
          await saveSnapshot(ctx.workspaceId, {
            files: ctx.files,
            cwd: ctx.cwd,
            git: ctx.git,
          });
        }
        return sand;
      }
    } catch (e) {
      console.warn('Vercel Sandbox failed, using /tmp:', e.message || e);
    }
  }

  const result = runInTempWorkspace({
    files: ctx.files,
    cwd: cwd || ctx.cwd,
    command: cmd,
    timeoutMs: 25000,
  });
  ctx.files = result.files;
  ctx.cwd = result.cwd || ctx.cwd;
  await saveSnapshot(ctx.workspaceId, {
    files: ctx.files,
    cwd: ctx.cwd,
    git: ctx.git,
  });
  return result;
}

async function executeRemoteTool(call, ctx) {
  const { workspaceId } = ctx;
  const tool = call.tool;
  const p = call.params || {};

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
    const guide = SKILL_GUIDES[name];
    if (!guide) {
      return {
        ok: false,
        tool,
        error: 'Unknown skill: ' + name,
        available: Object.keys(SKILL_GUIDES),
      };
    }
    return { ok: true, tool, name, text: guide, guide };
  }

  if (tool === 'execute_command') {
    const cmd = String(p.cmd || p.command || '').trim();
    if (!cmd) {
      return { ok: false, tool, error: 'cmd/command required' };
    }
    let cwd = p.cwd || ctx.cwd;
    if (p.cwd) {
      const resolved = resolveWorkspacePath(p.cwd, ctx.cwd);
      if (resolved.ok) cwd = resolved.path;
    }
    const result = await runCommand(ctx, cmd, cwd);
    return {
      ok: result.ok,
      tool,
      output: result.output,
      error: result.error,
      code: result.code,
      sandbox: !!result.sandbox,
      synced: !!result.synced,
    };
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

  if (tool === 'write_file' || tool === 'create_document' || tool === 'append_file') {
    let filePath;
    let content;
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
      previousContent: prev != null ? prev : undefined,
    };
    const saved = await putFile(workspaceId, {
      path: filePath,
      type: 'file',
      content: String(content),
    });
    await saveSnapshot(workspaceId, {
      files: ctx.files,
      cwd: ctx.cwd,
      git: ctx.git,
    });
    return {
      ok: true,
      tool,
      path: filePath,
      text: (tool === 'append_file' ? 'Appended ' : 'Wrote ') + filePath,
      previous:
        saved && saved._previousContent != null
          ? saved._previousContent
          : prev,
      content: String(content).slice(0, 500),
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
    ensureParentDirs(ctx.files, resolved.path + '/.keep');
    ctx.files[resolved.path] = {
      path: resolved.path,
      type: 'dir',
      children: ctx.files[resolved.path]
        ? ctx.files[resolved.path].children || []
        : [],
    };
    await putFile(workspaceId, ctx.files[resolved.path]);
    await saveSnapshot(workspaceId, {
      files: ctx.files,
      cwd: ctx.cwd,
      git: ctx.git,
    });
    return { ok: true, tool, path: resolved.path, text: 'Created ' + resolved.path };
  }

  if (tool === 'delete_file') {
    const resolved = resolveWorkspacePath(p.path || p.file, ctx.cwd);
    if (!resolved.ok) return { ok: false, tool, error: resolved.error };
    if (!ctx.files[resolved.path]) {
      return { ok: false, tool, error: 'Missing: ' + resolved.path };
    }
    delete ctx.files[resolved.path];
    await deleteFile(workspaceId, resolved.path);
    await saveSnapshot(workspaceId, {
      files: ctx.files,
      cwd: ctx.cwd,
      git: ctx.git,
    });
    return { ok: true, tool, path: resolved.path, text: 'Deleted ' + resolved.path };
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
    await saveSnapshot(workspaceId, { git: ctx.git, cwd: ctx.cwd, files: ctx.files });
    return { ok: true, tool, text: 'Initialized git repository' };
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
    await saveSnapshot(workspaceId, { git: ctx.git, cwd: ctx.cwd, files: ctx.files });
    return { ok: true, tool, text: 'Staged ' + target };
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
    await saveSnapshot(workspaceId, { git: ctx.git, cwd: ctx.cwd, files: ctx.files });
    return {
      ok: true,
      tool,
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
    await saveSnapshot(workspaceId, { git: ctx.git, cwd: ctx.cwd, files: ctx.files });
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

  return { ok: false, tool, error: 'Unsupported tool on remote API: ' + tool };
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
}) {
  const finalUsage = { ...usage, toolsUsed, steps };
  if (status === 'done') {
    await appendMessage(threadId, {
      role: 'assistant',
      content: full,
      meta: { usage: finalUsage },
    });
    await recordUsage(threadId, finalUsage, model);
    await saveAgentRun(threadId, {
      status: 'done',
      runId: usage.runId,
      step: steps,
      updatedAt: new Date().toISOString(),
    });
    emit({
      type: 'done',
      response: full,
      steps,
      usage: finalUsage,
    });
  }
  return { response: full, steps, usage: finalUsage, status };
}

async function runAgentLoop({
  threadId,
  workspaceId,
  userMessage,
  history,
  model,
  maxIterations,
  emit,
  resume,
  budgetMs,
}) {
  const meta = await getWorkspace(workspaceId);
  const files = (await listFiles(workspaceId)) || {};
  const ctx = {
    workspaceId,
    files,
    cwd: (meta && meta.cwd) || '/home/user',
    git:
      (meta && meta.git) || {
        initialized: false,
        branch: 'main',
        staged: [],
        commits: [],
      },
    todos: emptyTodos(),
  };

  const thr = await getThread(threadId);
  const existingRun = thr && thr.agentRun;
  const isResume =
    resume === true ||
    (resume !== false &&
      existingRun &&
      existingRun.status === 'interrupted' &&
      !userMessage);

  const startedAt = Date.now();
  const budget = budgetMs || DEFAULT_BUDGET_MS;
  const runId =
    (isResume && existingRun && existingRun.runId) || newId('run');
  const iterations = maxIterations || 25;

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
    verified: false,
  };

  if (isResume && existingRun && Array.isArray(existingRun.messages)) {
    messages = existingRun.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    full = existingRun.fullText || '';
    toolsUsed = existingRun.toolsUsed || 0;
    startStep = existingRun.step || 0;
    promptTokens = (existingRun.usage && existingRun.usage.promptTokensEst) || 0;
    completionTokens =
      (existingRun.usage && existingRun.usage.completionTokensEst) || 0;
    if (Array.isArray(existingRun.todos)) ctx.todos = existingRun.todos;
    if (existingRun.workflow) workflow = { ...workflow, ...existingRun.workflow };
    emit({
      type: 'resume',
      runId,
      step: startStep,
      max: iterations,
    });
  } else {
    messages = (history || [])
      .filter((m) => m && m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    messages.push({ role: 'user', content: userMessage });
    await appendMessage(threadId, { role: 'user', content: userMessage });

    const autoSkills = detectSkills(userMessage);
    emit({ type: 'skills', skills: autoSkills });

    messages.push({
      role: 'user',
      content: workflowBrief(
        autoSkills.length
          ? 'Auto-selected skills:\n' + skillBrief(autoSkills)
          : '',
      ),
    });
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
    workflow,
    startedAt: new Date(startedAt).toISOString(),
    model: usage.model,
  });

  const overBudget = () => Date.now() - startedAt >= budget;

  for (let i = startStep; i < iterations; i++) {
    if (overBudget()) {
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
        model: usage.model,
      });
      emit({
        type: 'interrupted',
        runId,
        step: i,
        reason: 'time_budget',
        resume: true,
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
        maxTokens: 3072,
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
        maxTokens: 3072,
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

    completionTokens = Math.max(completionTokens, estimateTokens(finalStepText));
    usage.completionTokensEst = completionTokens;
    usage.totalTokensEst = promptTokens + completionTokens;

    const tools = parseToolCalls(finalStepText, structuredCalls);
    const cleaned = cleanText(finalStepText);
    if (cleaned) {
      full += (full ? '\n\n' : '') + cleaned;
      emit({
        type: 'text',
        text: cleaned,
        final: tools.length === 0,
        step: i + 1,
        usage: { ...usage },
      });
    }

    if (!tools.length) {
      if (i === startStep && !isResume) {
        messages.push({ role: 'assistant', content: finalStepText || '' });
        messages.push({
          role: 'user',
          content:
            'OpenCode gate: no tools used. Start with view_tree or list_directory, then plan + todo({action:"set"}), then implement. Do not finish yet.',
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

      const gate = finishGate({
        state: workflow,
        todos: ctx.todos,
        step: i + 1,
        forcePlan: true,
      });
      if (gate) {
        messages.push({ role: 'assistant', content: finalStepText || '' });
        messages.push({ role: 'user', content: gate });
        emit({ type: 'text', text: gate, final: false, step: i + 1, gate: true });
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

      return finishRun({
        threadId,
        model: usage.model,
        full: full || cleaned || finalStepText,
        usage,
        toolsUsed,
        steps: i + 1,
        emit,
        status: 'done',
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
      emit({
        type: 'tool_start',
        tool: call.tool,
        params: call.params,
        id: call.id,
        structured: !!call.structured,
      });
      const result = await executeRemoteTool(call, ctx);
      workflow = recordToolPhase(workflow, call.tool);
      if (call.tool === 'todo' && result && result.todos) {
        ctx.todos = result.todos;
        emit({ type: 'todos', todos: ctx.todos });
      }
      results.push({ tool: call.tool, params: call.params, result });
      emit({ type: 'tool_result', tool: call.tool, id: call.id, result });

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
        model: usage.model,
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
      '\n\nOpenCode workflow status: explored=' +
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
      '\n\nContinue. Mark todos done. Verify before final summary WITHOUT tools.';
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
  full += (full ? '\n\n' : '') + msg;
  return finishRun({
    threadId,
    model: usage.model,
    full,
    usage,
    toolsUsed,
    steps: iterations,
    emit,
    status: 'done',
  });
}

module.exports = {
  runAgentLoop,
  parseToolCalls,
  executeRemoteTool,
  parseMarkdownToolCalls,
};
