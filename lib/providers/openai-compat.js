'use strict';

const { toOpenAiMessages } = require('./parse');

async function chatOpenAICompatible({
  baseUrl,
  apiKey,
  modelId,
  messages,
  maxTokens,
  headers,
}) {
  const res = await fetch(String(baseUrl).replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      ...(headers || {}),
    },
    body: JSON.stringify({
      model: modelId,
      messages: toOpenAiMessages(messages),
      max_tokens: maxTokens || 3072,
      temperature: 0.4,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data && data.error && (data.error.message || data.error)) ||
        'Provider error ' + res.status,
    );
  }
  const text =
    (data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content) ||
    '';
  return { response: text, raw: data, tool_calls: [] };
}

async function openrouterChat(opts) {
  return chatOpenAICompatible({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
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
  });
}

module.exports = { openrouterChat, openaiChat, chatOpenAICompatible };
