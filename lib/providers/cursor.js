'use strict';

/**
 * Cursor Cloud Agents API (https://api.cursor.com) — BYOK provider.
 * Not a chat-completions API: each Chatre turn is a no-repo agent run.
 */

const CURSOR_API_BASE = String(
  process.env.CURSOR_API_BASE || 'https://api.cursor.com',
).replace(/\/$/, '');

const CURSOR_FALLBACK_MODELS = [
  { id: 'composer-2.5', displayName: 'Composer 2.5' },
  { id: 'composer-2', displayName: 'Composer 2' },
  { id: 'composer-1.5', displayName: 'Composer 1.5' },
];

function normalizeCursorKey(apiKey) {
  let key = String(apiKey || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  if (/^bearer\s+/i.test(key)) key = key.replace(/^bearer\s+/i, '').trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key.replace(/\s+/g, '');
}

function cursorAuthHeaders(apiKey) {
  const key = normalizeCursorKey(apiKey);
  return {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageContent(m) {
  if (typeof m.content === 'string') return m.content;
  if (m.content == null) return '';
  if (Array.isArray(m.content)) {
    return m.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(m.content);
}

function wantsChatreTools(messages) {
  return (messages || []).some(
    (m) =>
      m &&
      m.role === 'system' &&
      /Tool calling format|```tool/i.test(String(m.content || '')),
  );
}

function messagesToPrompt(messages) {
  const toolMode = wantsChatreTools(messages);
  const parts = [];
  if (toolMode) {
    parts.push(
      'You are the model inside Chatre\'s agent loop. Chatre owns tools and file I/O. ' +
        'When you need a tool, emit a ```tool block exactly as the system messages require ' +
        '(JSON with "name" and "arguments"). Do not claim you already wrote files or ran tools — ' +
        'Chatre executes them after your reply. If you can answer without tools, reply in plain text.',
    );
  } else {
    parts.push(
      'You are answering inside Chatre (a chat product). Reply helpfully and directly. ' +
        'Do not invent download links. Prefer a clear final answer over scaffolding.',
    );
  }
  (messages || []).forEach((m) => {
    const role =
      m.role === 'system'
        ? 'System'
        : m.role === 'assistant'
          ? 'Assistant'
          : 'User';
    const content = messageContent(m);
    if (!String(content).trim()) return;
    parts.push(role + ':\n' + content);
  });
  parts.push('Assistant:');
  return parts.join('\n\n');
}

function buildModelSelection(modelId) {
  const id = String(modelId || '').trim();
  if (!id || /^auto$/i.test(id) || /^default$/i.test(id)) return null;
  return { id };
}

async function cursorFetch(path, { apiKey, method, body, accept }) {
  const headers = cursorAuthHeaders(apiKey);
  if (accept) headers.Accept = accept;
  const res = await fetch(CURSOR_API_BASE + path, {
    method: method || 'GET',
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const rawText = await res.text();
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { message: rawText };
  }
  if (!res.ok) {
    const msg =
      (data &&
        (data.message ||
          data.error ||
          data.code ||
          (data.error && data.error.message))) ||
      'Cursor API error ' + res.status;
    const err = new Error(
      typeof msg === 'string' ? msg : JSON.stringify(msg),
    );
    err.status = res.status;
    err.code = (data && data.code) || null;
    err.body = data;
    throw err;
  }
  return data;
}

async function cursorMe(apiKey) {
  return cursorFetch('/v1/me', { apiKey: normalizeCursorKey(apiKey) });
}

async function listCursorModels(apiKey) {
  try {
    const data = await cursorFetch('/v1/models', {
      apiKey: normalizeCursorKey(apiKey),
    });
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (items.length) {
      return items
        .map((it) => ({
          id: String((it && it.id) || '').trim(),
          displayName: String(
            (it && (it.displayName || it.id)) || '',
          ).trim(),
        }))
        .filter((it) => it.id);
    }
  } catch {
    /* fall through to static list */
  }
  return CURSOR_FALLBACK_MODELS.slice();
}

function extractAgentRunIds(created) {
  const agent = (created && created.agent) || created || {};
  const run = (created && created.run) || {};
  const agentId = String(agent.id || created.id || '').trim();
  const runId = String(
    run.id || agent.latestRunId || created.latestRunId || '',
  ).trim();
  return { agentId, runId };
}

function isTerminalStatus(status) {
  const s = String(status || '').toUpperCase();
  return (
    s === 'FINISHED' ||
    s === 'ERROR' ||
    s === 'CANCELLED' ||
    s === 'EXPIRED' ||
    s === 'COMPLETED'
  );
}

async function waitViaStream(apiKey, agentId, runId, maxWaitMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(10000, Number(maxWaitMs) || 90000),
  );
  try {
    const res = await fetch(
      CURSOR_API_BASE +
        '/v1/agents/' +
        encodeURIComponent(agentId) +
        '/runs/' +
        encodeURIComponent(runId) +
        '/stream',
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + normalizeCursorKey(apiKey),
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      },
    );
    if (!res.ok || !res.body) {
      throw new Error('Cursor stream HTTP ' + res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastStatus = '';
    let resultText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split(/\n\n/);
      buf = chunks.pop() || '';
      for (const chunk of chunks) {
        const lines = chunk.split('\n');
        let event = 'message';
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        let payload = {};
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }
        if (event === 'status' && payload.status) {
          lastStatus = String(payload.status);
        }
        if (event === 'result') {
          lastStatus = String(payload.status || lastStatus || 'FINISHED');
          resultText = String(payload.text || payload.result || '').trim();
          return {
            status: lastStatus,
            result: resultText,
            raw: payload,
            via: 'stream',
          };
        }
      }
    }
    if (resultText || isTerminalStatus(lastStatus)) {
      return {
        status: lastStatus || 'FINISHED',
        result: resultText,
        raw: null,
        via: 'stream',
      };
    }
    throw new Error('Cursor stream ended without result');
  } finally {
    clearTimeout(timer);
  }
}

async function waitViaPoll(apiKey, agentId, runId, maxWaitMs) {
  const deadline = Date.now() + Math.max(15000, Number(maxWaitMs) || 90000);
  let last = null;
  while (Date.now() < deadline) {
    last = await cursorFetch(
      '/v1/agents/' +
        encodeURIComponent(agentId) +
        '/runs/' +
        encodeURIComponent(runId),
      { apiKey },
    );
    const status = String((last && last.status) || '');
    if (isTerminalStatus(status)) {
      return {
        status,
        result: String((last && last.result) || '').trim(),
        raw: last,
        via: 'poll',
      };
    }
    await sleep(1500);
  }
  return {
    status: String((last && last.status) || 'unknown'),
    result: String((last && last.result) || '').trim(),
    raw: last,
    via: 'poll',
  };
}

/**
 * Chat / agent-step via Cloud Agents no-repo run.
 */
async function cursorChat({ apiKey, modelId, messages, maxWaitMs, mode }) {
  const key = normalizeCursorKey(apiKey);
  const prompt = messagesToPrompt(messages);
  const model = buildModelSelection(modelId);
  const body = {
    prompt: { text: prompt.slice(0, 100000) },
    name: 'Chatre',
    mode: mode === 'plan' ? 'plan' : 'agent',
  };
  if (model) body.model = model;

  let created;
  try {
    created = await cursorFetch('/v1/agents', {
      apiKey: key,
      method: 'POST',
      body,
    });
  } catch (err) {
    const code = String((err && err.code) || '');
    const msg = String((err && err.message) || err);
    if (/invalid_model|unknown model|model/i.test(code + ' ' + msg)) {
      throw new Error(
        'Cursor rejected model "' +
          (modelId || '') +
          '". Pick a model from Settings after saving your Cursor key (GET /v1/models), or use cursor:composer-2.5. ' +
          msg,
      );
    }
    if (/unauthorized|invalid api key|401/i.test(msg) || err.status === 401) {
      throw new Error(
        'Cursor rejected the API key. Create a user API key at https://cursor.com/dashboard/api and save it under BYOK → Cursor.',
      );
    }
    throw err;
  }

  const { agentId, runId } = extractAgentRunIds(created);
  if (!agentId || !runId) {
    throw new Error(
      'Cursor agent create returned no agent/run id: ' +
        JSON.stringify({
          keys: created && typeof created === 'object' ? Object.keys(created) : [],
        }),
    );
  }

  const waitMs =
    Number(maxWaitMs) ||
    Number(process.env.CURSOR_MAX_WAIT_MS) ||
    90000;

  let finished;
  try {
    finished = await waitViaStream(key, agentId, runId, waitMs);
  } catch {
    finished = await waitViaPoll(key, agentId, runId, waitMs);
  }

  const status = String((finished && finished.status) || '').toUpperCase();
  const text = String((finished && finished.result) || '').trim();

  if ((status === 'FINISHED' || status === 'COMPLETED') && text) {
    return {
      response: text,
      raw: finished.raw || finished,
      tool_calls: [],
      cursorAgentId: agentId,
      cursorRunId: runId,
    };
  }
  if ((status === 'FINISHED' || status === 'COMPLETED') && !text) {
    throw new Error(
      'Cursor run finished with empty result. Retry, or open the agent in Cursor dashboard.',
    );
  }
  if (status === 'ERROR' || status === 'CANCELLED' || status === 'EXPIRED') {
    throw new Error(
      'Cursor run ' + status.toLowerCase() + (text ? ': ' + text : ''),
    );
  }
  throw new Error(
    'Cursor run timed out (status=' + (status || 'unknown') + '). Cloud agent runs can take a minute — retry the message.',
  );
}

module.exports = {
  cursorChat,
  cursorMe,
  listCursorModels,
  normalizeCursorKey,
  CURSOR_FALLBACK_MODELS,
};
