'use strict';

async function googleChat({ apiKey, modelId, messages, maxTokens }) {
  const contents = [];
  let systemInstruction = null;
  (messages || []).forEach((m) => {
    if (m.role === 'system') {
      systemInstruction = {
        parts: [{ text: String(m.content || '') }],
      };
      return;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    });
  });

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(modelId) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens || 3072,
      temperature: 0.4,
    },
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data && data.error && data.error.message) ||
        'Google AI error ' + res.status,
    );
  }
  const parts =
    (data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts) ||
    [];
  const text = parts.map((p) => p.text || '').join('');
  return { response: text, raw: data, tool_calls: [] };
}

module.exports = { googleChat };
