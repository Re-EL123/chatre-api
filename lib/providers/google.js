'use strict';

function usesLegacySampling(modelId) {
  const id = String(modelId || '').toLowerCase();
  // Gemini 3.5-flash-lite and 3.6+ deprecate temperature/topP/topK
  if (/gemini-3\.6/.test(id) || /gemini-3\.[789]/.test(id)) return false;
  if (/gemini-3\.5-flash-lite/.test(id)) return false;
  return true;
}

async function googleChat({ apiKey, modelId, messages, maxTokens }) {
  let id = String(modelId || 'gemini-3.6-flash').trim();
  if (id.startsWith('models/')) id = id.slice('models/'.length);
  // Retired aliases → current flash default
  if (id === 'gemini-2.0-flash' || id === 'gemini-2.0-flash-001') {
    id = 'gemini-3.6-flash';
  }

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
    encodeURIComponent(id) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const generationConfig = {
    maxOutputTokens: maxTokens || 3072,
  };
  if (usesLegacySampling(id)) {
    generationConfig.temperature = 0.4;
  }

  const body = {
    contents,
    generationConfig,
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
