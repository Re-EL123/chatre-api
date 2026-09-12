'use strict';

const { toOpenAiMessages } = require('./parse');

async function chatOpenAICompatible({
  baseUrl,
  apiKey,
  modelId,
  messages,
  maxTokens,
  headers,
  tools,
}) {
  const body = {
    model: modelId,
    messages: toOpenAiMessages(messages),
    max_tokens: maxTokens || 3072,
    temperature: 0.4,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const res = await fetch(String(baseUrl).replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      ...(headers || {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data && data.error && (data.error.message || data.error)) ||
        'Provider error ' + res.status,
    );
  }
  const msg =
    (data.choices && data.choices[0] && data.choices[0].message) || {};
  const text = msg.content || '';
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const tool_calls = rawCalls
    .map((c) => {
      try {
        const name = (c.function && c.function.name) || c.name;
        let args = (c.function && c.function.arguments) || c.arguments || '{}';
        if (typeof args === 'string') args = JSON.parse(args || '{}');
        return {
          id: c.id || name,
          tool: name,
          name,
          params: args && typeof args === 'object' ? args : {},
          structured: true,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { response: text, raw: data, tool_calls };
}

async function openrouterChat(opts) {
  return chatOpenAICompatible({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    headers: {
      'HTTP-Referer':
        process.env.OPENROUTER_HTTP_REFERER || 'https://chatre.app',
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'Chatre',
    },
  });
}

async function openaiChat(opts) {
  return chatOpenAICompatible({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
  });
}

module.exports = { openrouterChat, openaiChat, chatOpenAICompatible };
