'use strict';

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

module.exports = { chatWorker };
