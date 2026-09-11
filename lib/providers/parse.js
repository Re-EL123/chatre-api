'use strict';

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
    if (['openrouter', 'anthropic', 'openai', 'google', 'chatre'].includes(provider)) {
      return { provider, modelId };
    }
  }
  return { provider: 'chatre', modelId: raw };
}

function toOpenAiMessages(messages) {
  return (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
}

module.exports = { parseModel, toOpenAiMessages };
