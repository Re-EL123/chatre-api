'use strict';

/**
 * Stream chat from the Cloudflare Worker and emit token deltas.
 */
async function chatWorker({ messages, model, maxTokens, stream, agent }) {
  const base = String(process.env.CHATRE_WORKER_URL || '').replace(/\/$/, '');
  if (!base) {
    throw new Error('CHATRE_WORKER_URL is not configured');
  }
  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.CHATRE_WORKER_SECRET;
  if (secret) {
    headers.Authorization = 'Bearer ' + secret;
    headers['x-chatre-key'] = secret;
  }

  const res = await fetch(base + '/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages,
      stream: stream === true,
      agent: agent !== false,
      model,
      max_tokens: maxTokens || 3072,
    }),
  });

  if (!res.ok) {
    let err = 'Worker chat failed (' + res.status + ')';
    try {
      const j = await res.json();
      if (j && j.error) err = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(err);
  }

  if (stream) return res;
  const data = await res.json();
  return data.response || '';
}

function extractStreamTokens(chunk, carry) {
  const combined = carry + chunk;
  const lines = combined.split('\n');
  const nextCarry = lines.pop() || '';
  let text = '';
  for (let line of lines) {
    line = line.trim();
    if (!line || line === 'data: [DONE]' || line === '[DONE]') continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (!line || line === '[DONE]') continue;
    try {
      const json = JSON.parse(line);
      if (typeof json.response === 'string') text += json.response;
      else if (typeof json.text === 'string') text += json.text;
      else if (typeof json.token === 'string') text += json.token;
    } catch {
      /* ignore */
    }
  }
  return { text, carry: nextCarry };
}

/**
 * Stream tokens from the Worker; calls onToken(delta) and returns full text.
 */
async function chatWorkerStreaming({
  messages,
  model,
  maxTokens,
  agent,
  onToken,
}) {
  const res = await chatWorker({
    messages,
    model,
    maxTokens,
    stream: true,
    agent,
  });

  if (!res.body) {
    // Fallback: some gateways still return JSON
    const data = await res.json().catch(() => ({}));
    const text = data.response || '';
    if (text && onToken) onToken(text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const parsed = extractStreamTokens(chunk, carry);
    carry = parsed.carry;
    if (parsed.text) {
      full += parsed.text;
      if (onToken) onToken(parsed.text);
    }
  }

  if (carry.trim()) {
    try {
      const maybe = JSON.parse(carry.trim());
      if (typeof maybe.response === 'string' && !full) {
        full = maybe.response;
        if (onToken) onToken(full);
      } else {
        const parsed = extractStreamTokens(carry + '\n', '');
        if (parsed.text) {
          full += parsed.text;
          if (onToken) onToken(parsed.text);
        }
      }
    } catch {
      const parsed = extractStreamTokens(carry + '\n', '');
      if (parsed.text) {
        full += parsed.text;
        if (onToken) onToken(parsed.text);
      }
    }
  }

  return full;
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

module.exports = {
  chatWorker,
  chatWorkerStreaming,
  estimateTokens,
};
