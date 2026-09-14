'use strict';

const { isByokProvider } = require('./byok-providers');

function parseModel(model) {
  const raw = String(model || '').trim();
  if (!raw) {
    return { provider: 'chatre', modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };
  }
  if (raw.startsWith('@cf/') || raw.startsWith('chatre:')) {
    return {
      provider: 'chatre',
      modelId: raw.replace(/^chatre:/, ''),
    };
  }
  const idx = raw.indexOf(':');
  if (idx > 0) {
    const provider = raw.slice(0, idx).toLowerCase();
    const modelId = raw.slice(idx + 1);
    if (provider === 'chatre' || isByokProvider(provider)) {
      return { provider, modelId };
    }
  }
  return { provider: 'chatre', modelId: raw };
}

function toOpenAiMessages(messages) {
  return (messages || []).map((m) => {
    if (m && m.role === 'tool') {
      const out = {
        role: 'tool',
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content == null
              ? ''
              : JSON.stringify(m.content),
      };
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
      return out;
    }
    const role =
      m.role === 'assistant'
        ? 'assistant'
        : m.role === 'system'
          ? 'system'
          : 'user';
    const content =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
          : m.content == null
            ? ''
            : JSON.stringify(m.content);
    const out = { role, content };
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls;
      // OpenAI requires content null/string when tool_calls present
      if (out.content === '') out.content = null;
    }
    // OpenRouter Gemini / reasoning models may require these on follow-up turns
    if (m.reasoning_details) out.reasoning_details = m.reasoning_details;
    if (m.reasoning) out.reasoning = m.reasoning;
    if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
    return out;
  });
}

module.exports = { parseModel, toOpenAiMessages };
