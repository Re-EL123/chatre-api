'use strict';

function flattenMessageContent(m) {
  if (!m) return '';
  if (m.role === 'tool') {
    return (
      'Tool result' +
      (m.name ? ' (' + m.name + ')' : '') +
      ':\n' +
      (typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content || {}))
    );
  }
  let text =
    typeof m.content === 'string'
      ? m.content
      : m.content == null
        ? ''
        : JSON.stringify(m.content);
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    text =
      (text ? text + '\n' : '') +
      JSON.stringify({ tool_calls: m.tool_calls });
  }
  return text;
}

async function anthropicChat({ apiKey, modelId, messages, maxTokens }) {
  const systemParts = [];
  const converted = [];
  (messages || []).forEach((m) => {
    if (!m) return;
    if (m.role === 'system') {
      systemParts.push(String(m.content || ''));
      return;
    }
    // Anthropic only accepts user/assistant — flatten tool roles into user turns.
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    converted.push({
      role,
      content: flattenMessageContent(m),
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
