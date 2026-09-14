'use strict';

const CURSOR_API_BASE = String(
  process.env.CURSOR_API_BASE || 'https://api.cursor.com',
).replace(/\/$/, '');

const CURSOR_FALLBACK_MODELS = [
  { id: 'composer-2.5', displayName: 'Composer 2.5' },
  { id: 'composer-2', displayName: 'Composer 2' },
  { id: 'composer-1.5', displayName: 'Composer 1.5' },
];

function cursorAuthHeaders(apiKey) {
  return {
    Authorization: 'Bearer ' + String(apiKey || '').trim(),
    'Content-Type': 'application/json',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messagesToPrompt(messages) {
  const parts = [];
  parts.push(
    'You are answering inside Chatre (a chat/agent product). ' +
      'Reply helpfully and directly. Do not invent download links. ' +
      'Only create files or run tools if the user explicitly asks.',
  );
  (messages || []).forEach((m) => {
    const role =
      m.role === 'system'
        ? 'System'
        : m.role === 'assistant'
          ? 'Assistant'
          : 'User';
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content == null
          ? ''
          : JSON.stringify(m.content);
    if (!String(content).trim()) return;
    parts.push(role + ':\n' + content);
  });
  parts.push('Assistant:');
  return parts.join('\n\n');
}

async function cursorFetch(path, { apiKey, method, body }) {
  const res = await fetch(CURSOR_API_BASE + path, {
    method: method || 'GET',
    headers: cursorAuthHeaders(apiKey),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data && (data.message || data.error || data.code)) ||
      'Cursor API error ' + res.status;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

async function cursorMe(apiKey) {
  return cursorFetch('/v1/me', { apiKey });
}

async function listCursorModels(apiKey) {
  try {
    const data = await cursorFetch('/v1/models', { apiKey });
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

/**
 * Chat via Cloud Agents no-repo run (Cursor has no chat-completions API).
 */
async function cursorChat({ apiKey, modelId, messages, maxWaitMs }) {
  const prompt = messagesToPrompt(messages);
  const id = String(modelId || 'composer-2.5').trim() || 'composer-2.5';
  const created = await cursorFetch('/v1/agents', {
    apiKey,
    method: 'POST',
    body: {
      prompt: { text: prompt },
      model: { id },
      name: 'Chatre',
      mode: 'agent',
    },
  });
  const agentId =
    (created && created.agent && created.agent.id) ||
    (created && created.id) ||
    '';
  const runId =
    (created && created.run && created.run.id) ||
    (created && created.agent && created.agent.latestRunId) ||
    '';
  if (!agentId || !runId) {
    throw new Error('Cursor agent create returned no agent/run id');
  }

  const deadline = Date.now() + Math.max(15000, Number(maxWaitMs) || 120000);
  let last = null;
  while (Date.now() < deadline) {
    last = await cursorFetch(
      '/v1/agents/' +
        encodeURIComponent(agentId) +
        '/runs/' +
        encodeURIComponent(runId),
      { apiKey },
    );
    const status = String((last && last.status) || '').toUpperCase();
    if (
      status === 'FINISHED' ||
      status === 'ERROR' ||
      status === 'CANCELLED' ||
      status === 'EXPIRED'
    ) {
      break;
    }
    await sleep(2000);
  }

  const status = String((last && last.status) || '').toUpperCase();
  const text = String((last && last.result) || '').trim();
  if (status === 'FINISHED' && text) {
    return {
      response: text,
      raw: last,
      tool_calls: [],
      cursorAgentId: agentId,
      cursorRunId: runId,
    };
  }
  if (status === 'FINISHED' && !text) {
    throw new Error('Cursor run finished with empty result');
  }
  if (status === 'ERROR' || status === 'CANCELLED' || status === 'EXPIRED') {
    throw new Error(
      'Cursor run ' + status.toLowerCase() + (text ? ': ' + text : ''),
    );
  }
  throw new Error(
    'Cursor run timed out (status=' + (status || 'unknown') + ')',
  );
}

module.exports = {
  cursorChat,
  cursorMe,
  listCursorModels,
  CURSOR_FALLBACK_MODELS,
};
