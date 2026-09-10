'use strict';

const { chatWorkerStreaming, estimateTokens } = require('./llm');
const { listFiles, getWorkspace, saveSnapshot, putFile } = require('./workspace');
const { runInTempWorkspace } = require('./shell');
const { runInVercelSandbox } = require('./sandbox');
const { appendMessage } = require('./threads');
const { detectSkills, skillBrief } = require('./skills');

const TOOL_RESULT_SOFT_LIMIT = 1800;
const CONTEXT_SOFT_LIMIT = 6500;

function parseToolCalls(text) {
  const results = [];
  const blockRe = /```(?:tool|tool_call|agent)\s*\n?([\s\S]*?)```/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) {
        parsed.forEach((item) => {
          if (item && item.tool) results.push(normalize(item));
        });
      } else if (parsed && parsed.tool) {
        results.push(normalize(parsed));
      }
    } catch {
      /* ignore */
    }
  }
  return results;
}

function normalize(item) {
  return {
    tool: item.tool,
    params: item.params || {},
    id: item.id || 'tc_' + Math.random().toString(36).slice(2, 8),
  };
}

function cleanText(text) {
  return String(text || '')
    .replace(/```(?:tool|tool_call|agent)\s*\n?[\s\S]*?```/g, '')
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
    const t = estimateTokens(msg.content) + 4;
    if (total + t > CONTEXT_SOFT_LIMIT && kept.length > 3) {
      // Collapse older middle into a summary stub once
      break;
    }
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
      // skipped (package missing) → /tmp allowlist below
    } catch (e) {
      // Sandbox threw — fall through to /tmp allowlist
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

  if (tool === 'plan' || tool === 'list_skills' || tool === 'use_skill') {
    return {
      ok: true,
      tool,
      text:
        tool === 'plan'
          ? 'Plan recorded: ' + String(p.steps || '')
          : tool === 'list_skills'
            ? 'coding, documents, git, debugging, research, project'
            : 'Skill loaded: ' + String(p.name || ''),
    };
  }

  if (tool === 'execute_command') {
    const result = await runCommand(ctx, p.cmd, p.cwd);
    return {
      ok: result.ok,
      tool,
      output: result.output,
      error: result.error,
      code: result.code,
      sandbox: !!result.sandbox,
    };
  }

  if (tool === 'write_file' || tool === 'create_document') {
    let filePath = p.path;
    let content = p.content || '';
    if (tool === 'create_document') {
      const safe =
        String(p.title || 'document')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'document';
      filePath = '/home/user/documents/' + safe + '.md';
      content = '# ' + (p.title || 'Document') + '\n\n' + String(p.content || '');
    }
    const parts = String(filePath).split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = cur || '/';
      cur = cur + '/' + parts[i];
      if (!ctx.files[cur]) {
        ctx.files[cur] = { path: cur, type: 'dir', children: [] };
        if (ctx.files[parent] && Array.isArray(ctx.files[parent].children)) {
          if (!ctx.files[parent].children.includes(parts[i])) {
            ctx.files[parent].children.push(parts[i]);
          }
        }
      }
    }
    const parent = filePath.replace(/\/[^/]+$/, '') || '/';
    const name = filePath.split('/').pop();
    if (ctx.files[parent] && Array.isArray(ctx.files[parent].children)) {
      if (!ctx.files[parent].children.includes(name)) {
        ctx.files[parent].children.push(name);
      }
    }
    const prev = ctx.files[filePath] && ctx.files[filePath].type === 'file'
      ? ctx.files[filePath].content || ''
      : null;
    ctx.files[filePath] = {
      path: filePath,
      type: 'file',
      content: String(content),
    };
    await putFile(workspaceId, ctx.files[filePath]);
    await saveSnapshot(workspaceId, {
      files: ctx.files,
      cwd: ctx.cwd,
      git: ctx.git,
    });
    return {
      ok: true,
      tool,
      path: filePath,
      text: 'Wrote ' + filePath,
      previous: prev,
      content: String(content).slice(0, 500),
    };
  }

  if (tool === 'read_file') {
    const f = ctx.files[p.path];
    if (!f || f.type !== 'file') {
      return { ok: false, tool, error: 'No such file: ' + p.path };
    }
    return { ok: true, tool, path: p.path, content: f.content || '' };
  }

  if (tool === 'list_directory' || tool === 'view_tree') {
    const target = p.path || ctx.cwd || '/home/user';
    const entry = ctx.files[target];
    if (!entry) return { ok: false, tool, error: 'Missing: ' + target };
    if (tool === 'list_directory') {
      return {
        ok: true,
        tool,
        path: target,
        entries:
          entry.type === 'dir'
            ? entry.children || []
            : [target.split('/').pop()],
      };
    }
    return {
      ok: true,
      tool,
      output: Object.keys(ctx.files).filter(Boolean).sort().join('\n'),
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
    const target = p.path || '.';
    if (!ctx.git.staged.includes(target)) ctx.git.staged.push(target);
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
    const keys = Object.keys(ctx.files || {}).filter(
      (k) => ctx.files[k].type === 'file',
    );
    return {
      ok: keys.length > 0,
      tool,
      fileCount: keys.length,
      text: keys.length ? 'Found ' + keys.length + ' files' : 'No files',
    };
  }

  return { ok: false, tool, error: 'Unsupported tool on remote API: ' + tool };
}

async function runAgentLoop({
  threadId,
  workspaceId,
  userMessage,
  history,
  model,
  maxIterations,
  emit,
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
  };

  const messages = (history || [])
    .filter((m) => m && m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  messages.push({ role: 'user', content: userMessage });
  await appendMessage(threadId, { role: 'user', content: userMessage });

  const autoSkills = detectSkills(userMessage);
  emit({ type: 'skills', skills: autoSkills });

  messages.push({
    role: 'user',
    content:
      'AGENT BRIEF: Be thorough.\n' +
      (autoSkills.length
        ? 'Auto-selected skills:\n' + skillBrief(autoSkills) + '\n'
        : '') +
      'Plan first, inspect workspace, implement complete files, verify, document, commit/push when asked. Use ```tool JSON blocks. Stream-friendly short narration between tools.',
  });

  let full = '';
  let promptTokens = estimateTokens(JSON.stringify(messages));
  let completionTokens = 0;
  let toolsUsed = 0;
  const iterations = maxIterations || 20;
  const usage = {
    model: model || 'default',
    steps: 0,
    toolsUsed: 0,
    promptTokensEst: promptTokens,
    completionTokensEst: 0,
    totalTokensEst: promptTokens,
  };

  for (let i = 0; i < iterations; i++) {
    usage.steps = i + 1;
    emit({ type: 'thinking', step: i + 1, max: iterations, usage: { ...usage } });

    let stepText = '';
    const text = await chatWorkerStreaming({
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

    const finalStepText = text || stepText;
    completionTokens = Math.max(completionTokens, estimateTokens(finalStepText));
    usage.completionTokensEst = completionTokens;
    usage.totalTokensEst = promptTokens + completionTokens;

    const tools = parseToolCalls(finalStepText);
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
      if (i === 0) {
        messages.push({ role: 'assistant', content: finalStepText || '' });
        messages.push({
          role: 'user',
          content:
            'You did not use tools. Start with a plan tool call, then implement. Do not finish yet.',
        });
        continue;
      }
      await appendMessage(threadId, {
        role: 'assistant',
        content: full || cleaned || finalStepText,
        meta: { usage },
      });
      emit({
        type: 'done',
        response: full || cleaned || finalStepText,
        steps: i + 1,
        usage: { ...usage, toolsUsed },
      });
      return {
        response: full || cleaned || finalStepText,
        steps: i + 1,
        usage: { ...usage, toolsUsed },
      };
    }

    messages.push({ role: 'assistant', content: finalStepText });
    const results = [];
    for (const call of tools) {
      toolsUsed += 1;
      usage.toolsUsed = toolsUsed;
      emit({
        type: 'tool_start',
        tool: call.tool,
        params: call.params,
        id: call.id,
      });
      const result = await executeRemoteTool(call, ctx);
      results.push({ tool: call.tool, params: call.params, result });
      emit({ type: 'tool_result', tool: call.tool, id: call.id, result });
    }

    const summarized = summarizeToolResults(results);
    const feed =
      'Tool execution results (summarized if large):\n' +
      JSON.stringify(summarized, null, 2) +
      '\n\nContinue. When complete, summarize WITHOUT tools.';
    messages.push({ role: 'user', content: feed });
    promptTokens += estimateTokens(feed);
    usage.promptTokensEst = promptTokens;
    usage.totalTokensEst = promptTokens + completionTokens;
  }

  const msg = 'Reached max agent steps (' + iterations + ').';
  full += (full ? '\n\n' : '') + msg;
  await appendMessage(threadId, {
    role: 'assistant',
    content: full,
    meta: { usage: { ...usage, toolsUsed } },
  });
  emit({
    type: 'done',
    response: full,
    steps: iterations,
    usage: { ...usage, toolsUsed },
  });
  return { response: full, steps: iterations, usage: { ...usage, toolsUsed } };
}

module.exports = { runAgentLoop, parseToolCalls, executeRemoteTool };
