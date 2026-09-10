'use strict';

const { chatWorker } = require('./llm');
const { listFiles, getWorkspace, saveSnapshot, putFile } = require('./workspace');
const { runInTempWorkspace } = require('./shell');
const { appendMessage } = require('./threads');

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
  return String(text || '').replace(/```(?:tool|tool_call|agent)\s*\n?[\s\S]*?```/g, '').trim();
}

async function executeRemoteTool(call, ctx) {
  const { workspaceId, files, cwd, git } = ctx;
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
    const result = runInTempWorkspace({
      files: ctx.files,
      cwd: p.cwd || ctx.cwd,
      command: p.cmd,
      timeoutMs: 25000,
    });
    ctx.files = result.files;
    ctx.cwd = result.cwd || ctx.cwd;
    await saveSnapshot(workspaceId, {
      files: ctx.files,
      cwd: ctx.cwd,
      git: ctx.git,
    });
    return {
      ok: result.ok,
      tool,
      output: result.output,
      error: result.error,
      code: result.code,
    };
  }

  if (tool === 'write_file' || tool === 'create_document') {
    let filePath = p.path;
    let content = p.content || '';
    if (tool === 'create_document') {
      const safe = String(p.title || 'document')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'document';
      filePath = '/home/user/documents/' + safe + '.md';
      content = '# ' + (p.title || 'Document') + '\n\n' + String(p.content || '');
    }
    // ensure parents
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
    ctx.files[filePath] = {
      path: filePath,
      type: 'file',
      content: String(content),
    };
    await putFile(workspaceId, ctx.files[filePath]);
    await saveSnapshot(workspaceId, { files: ctx.files, cwd: ctx.cwd, git: ctx.git });
    return { ok: true, tool, path: filePath, text: 'Wrote ' + filePath, content: content.slice(0, 500) };
  }

  if (tool === 'read_file') {
    const f = ctx.files[p.path];
    if (!f || f.type !== 'file') return { ok: false, tool, error: 'No such file: ' + p.path };
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
        entries: entry.type === 'dir' ? entry.children || [] : [target.split('/').pop()],
      };
    }
    return { ok: true, tool, output: JSON.stringify(Object.keys(ctx.files).slice(0, 200), null, 2) };
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
    ctx.git = ctx.git || { initialized: true, staged: [], commits: [], branch: 'main' };
    ctx.git.initialized = true;
    const target = p.path || '.';
    if (!ctx.git.staged.includes(target)) ctx.git.staged.push(target);
    await saveSnapshot(workspaceId, { git: ctx.git, cwd: ctx.cwd, files: ctx.files });
    return { ok: true, tool, text: 'Staged ' + target };
  }

  if (tool === 'git_commit') {
    ctx.git = ctx.git || { initialized: false, staged: [], commits: [], branch: 'main' };
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
    return { ok: true, tool, text: 'Committed: ' + commit.message, hash: commit.hash };
  }

  if (tool === 'git_status') {
    return {
      ok: true,
      tool,
      output: JSON.stringify(ctx.git || {}, null, 2),
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
    const keys = Object.keys(ctx.files || {}).filter((k) => ctx.files[k].type === 'file');
    return {
      ok: keys.length > 0,
      tool,
      fileCount: keys.length,
      text: keys.length ? 'Found ' + keys.length + ' files' : 'No files',
    };
  }

  // Fallback: run as shell for unknown tools named execute_*
  return { ok: false, tool, error: 'Unsupported tool on remote API: ' + tool };
}

/**
 * Streaming agent loop. emit(event) sends SSE payloads.
 */
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
    git: (meta && meta.git) || { initialized: false, branch: 'main', staged: [], commits: [] },
  };

  const messages = (history || [])
    .filter((m) => m && m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  messages.push({ role: 'user', content: userMessage });
  await appendMessage(threadId, { role: 'user', content: userMessage });

  messages.push({
    role: 'user',
    content:
      'AGENT BRIEF: Be thorough. Plan first, inspect workspace, implement complete files, verify with execute_command, document, then git commit/push when asked. Use ```tool JSON blocks.',
  });

  let full = '';
  const iterations = maxIterations || 20;

  for (let i = 0; i < iterations; i++) {
    emit({ type: 'thinking', step: i + 1, max: iterations });
    const text = await chatWorker({
      messages,
      model,
      maxTokens: 3072,
      stream: false,
      agent: true,
    });

    const tools = parseToolCalls(text);
    const cleaned = cleanText(text);
    if (cleaned) {
      full += (full ? '\n\n' : '') + cleaned;
      emit({ type: 'text', text: cleaned, final: tools.length === 0 });
    }

    if (!tools.length) {
      if (i === 0) {
        messages.push({ role: 'assistant', content: text || '' });
        messages.push({
          role: 'user',
          content:
            'You did not use tools. Start with a plan tool call, then implement. Do not finish yet.',
        });
        continue;
      }
      await appendMessage(threadId, { role: 'assistant', content: full || cleaned || text });
      emit({ type: 'done', response: full || cleaned || text, steps: i + 1 });
      return { response: full || cleaned || text, steps: i + 1 };
    }

    messages.push({ role: 'assistant', content: text });
    const results = [];
    for (const call of tools) {
      emit({ type: 'tool_start', tool: call.tool, params: call.params, id: call.id });
      const result = await executeRemoteTool(call, ctx);
      results.push({ tool: call.tool, params: call.params, result });
      emit({ type: 'tool_result', tool: call.tool, id: call.id, result });
    }

    messages.push({
      role: 'user',
      content:
        'Tool execution results:\n' +
        JSON.stringify(results, null, 2) +
        '\n\nContinue. When complete, summarize WITHOUT tools.',
    });
  }

  const msg = 'Reached max agent steps (' + iterations + ').';
  full += (full ? '\n\n' : '') + msg;
  await appendMessage(threadId, { role: 'assistant', content: full });
  emit({ type: 'done', response: full, steps: iterations });
  return { response: full, steps: iterations };
}

module.exports = { runAgentLoop, parseToolCalls, executeRemoteTool };
