'use strict';

const { toOpenAiMessages } = require('./parse');

function isGemini3Model(modelId) {
  return /gemini-3/i.test(String(modelId || ''));
}

function isReasoningHeavyModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  return (
    isGemini3Model(id) ||
    /gemini-2\.5/.test(id) ||
    /\bo1\b|\bo3\b|\bo4-mini\b/.test(id) ||
    /deepseek-r1|:r1\b|reasoning|thinking/.test(id)
  );
}

function skipsSamplingParams(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/gemini-3\.6/.test(id) || /gemini-3\.[789]/.test(id)) return true;
  if (/gemini-3\.5-flash-lite/.test(id)) return true;
  return false;
}

/** Flatten OpenAI/OpenRouter message content (string | parts[]). */
function extractMessageContent(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === 'string') return p;
        if (!p || typeof p !== 'object') return '';
        if (typeof p.text === 'string') return p.text;
        if (p.type === 'text' && typeof p.text === 'string') return p.text;
        if (typeof p.content === 'string') return p.content;
        return '';
      })
      .join('');
  }
  if (c != null && typeof c !== 'object') return String(c);
  return '';
}

function extractReasoningFallback(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) {
    return msg.reasoning.trim();
  }
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
    return msg.reasoning_content.trim();
  }
  if (Array.isArray(msg.reasoning_details)) {
    return msg.reasoning_details
      .map((d) => {
        if (!d) return '';
        if (typeof d === 'string') return d;
        return d.text || d.content || d.summary || '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function extractOpenAiCompatibleText(data) {
  const choice = data && data.choices && data.choices[0];
  if (!choice) {
    return {
      text: '',
      tool_calls: [],
      error:
        'Provider returned no choices (empty response). Check model id, credits, or try again.',
    };
  }
  const msg = choice.message || {};
  const finish = String(choice.finish_reason || choice.native_finish_reason || '');
  let text = extractMessageContent(msg).trim();
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  if (!text) {
    const reasoning = extractReasoningFallback(msg);
    if (reasoning) text = reasoning;
  }

  if (!text && !rawCalls.length) {
    if (finish === 'length' || finish === 'max_tokens') {
      return {
        text: '',
        tool_calls: [],
        error:
          'Model hit the output token limit with no visible text (common on reasoning/Gemini models). Raise max tokens or set reasoning effort to minimal.',
        finishReason: finish,
        message: msg,
      };
    }
    if (finish === 'content_filter') {
      return {
        text: '',
        tool_calls: [],
        error: 'Provider blocked the response (content_filter).',
        finishReason: finish,
        message: msg,
      };
    }
    return {
      text: '',
      tool_calls: [],
      error:
        'Model returned an empty message' +
        (finish ? ' (finish_reason=' + finish + ')' : '') +
        '.',
      finishReason: finish,
      message: msg,
    };
  }

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

  return {
    text,
    tool_calls,
    error: null,
    finishReason: finish || null,
    message: msg,
    reasoning_details: msg.reasoning_details || null,
    reasoning: msg.reasoning || msg.reasoning_content || null,
  };
}

async function chatOpenAICompatible({
  baseUrl,
  apiKey,
  modelId,
  messages,
  maxTokens,
  headers,
  tools,
  reasoningEffort,
}) {
  let outTokens = Number(maxTokens) || 3072;
  // Reasoning models spend budget on thoughts first — keep room for the answer.
  if (isReasoningHeavyModel(modelId)) {
    outTokens = Math.max(outTokens, 1024);
  }

  const body = {
    model: modelId,
    messages: toOpenAiMessages(messages),
    max_tokens: outTokens,
  };
  if (!skipsSamplingParams(modelId)) {
    body.temperature = 0.4;
  }
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // OpenRouter / reasoning models: prefer minimal effort and exclude reasoning
  // payload so multi-turn chat does not require preserving reasoning_details.
  if (isReasoningHeavyModel(modelId)) {
    body.reasoning = {
      effort: String(reasoningEffort || 'minimal').toLowerCase(),
      exclude: true,
    };
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

  const extracted = extractOpenAiCompatibleText(data);
  if (extracted.error && !extracted.text && !(extracted.tool_calls && extracted.tool_calls.length)) {
    throw new Error(extracted.error);
  }
  return {
    response: extracted.text || '',
    raw: data,
    tool_calls: extracted.tool_calls || [],
    finishReason: extracted.finishReason || null,
    reasoning_details: extracted.reasoning_details,
    reasoning: extracted.reasoning,
  };
}

async function openrouterChat(opts) {
  return chatOpenAICompatible({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
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
    reasoningEffort: opts.reasoningEffort,
  });
}

async function aihubmixChat(opts) {
  return chatOpenAICompatible({
    baseUrl: process.env.AIHUBMIX_BASE_URL || 'https://aihubmix.com/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function zaiChat(opts) {
  return chatOpenAICompatible({
    baseUrl: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
    headers: {
      'Accept-Language': 'en-US,en',
    },
  });
}

module.exports = {
  openrouterChat,
  openaiChat,
  aihubmixChat,
  zaiChat,
  chatOpenAICompatible,
  extractOpenAiCompatibleText,
  extractMessageContent,
};
