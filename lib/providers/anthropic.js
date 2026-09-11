'use strict';

async function anthropicChat({ apiKey, modelId, messages, maxTokens }) {
  const systemParts = [];
  const converted = [];
  (messages || []).forEach((m) => {
    if (m.role === 'system') {
      systemParts.push(String(m.content || ''));
      return;
    }
    converted.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
    });
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens || 3072,
      system: systemParts.length ? systemParts.join('\n\n') : undefined,
      messages: converted,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data && data.error && data.error.message) ||
        'Anthropic error ' + res.status,
    );
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { response: text, raw: data, tool_calls: [] };
}

module.exports = { anthropicChat };
