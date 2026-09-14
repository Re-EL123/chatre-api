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

/**
 * OpenRouter/OpenAI-compat reasoning.effort — never send unsupported
 * `minimal` for Gemini 3.7/3.8/Pro (maps to Google MINIMAL).
 */
function resolveReasoningEffort(modelId, requested) {
  if (!isReasoningHeavyModel(modelId)) return null;
  const id = String(modelId || '').toLowerCase();
  let want = String(requested || '').toLowerCase().trim();
  const noMinimal =
    /gemini-3\.[78]|gemini-3\.1-pro|gemini-3-pro/.test(id) ||
    (/gemini-3/.test(id) && !/gemini-3\.6|gemini-3\.5|gemini-3-flash-preview/.test(id));
  if (!want) want = noMinimal ? 'low' : 'minimal';
  if (noMinimal && want === 'minimal') want = 'low';
  return want;
}

function isReasoningEffortError(err) {
  const msg = String((err && err.message) || err || '');
  return /thinking\s*level|THINKING_LEVEL|reasoning\.?effort|not supported for this model/i.test(
    msg,
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
      const name = (c.function && c.function.name) || c.name;
      if (!name) return null;
      let args = (c.function && c.function.arguments) || c.arguments || '{}';
      let parseFailed = false;
      let params = {};
      if (typeof args === 'string') {
        try {
          params = JSON.parse(args || '{}');
        } catch {
          parseFailed = true;
          params = {};
        }
      } else if (args && typeof args === 'object') {
        params = args;
      } else {
        parseFailed = true;
      }
      return {
        id: c.id || name,
        tool: name,
        name,
        params: params && typeof params === 'object' ? params : {},
        structured: true,
        parseFailed,
        rawArguments: typeof args === 'string' ? args : undefined,
      };
    })
    .filter(Boolean);

  if (
    !text &&
    tool_calls.length &&
    tool_calls.every((c) => c.parseFailed) &&
    (finish === 'tool_calls' || finish === 'function_call' || !finish)
  ) {
    return {
      text: '',
      tool_calls,
      error:
        'Model returned tool_calls but arguments JSON was truncated/invalid. Re-emit smaller tool calls or raise max tokens.',
      finishReason: finish || null,
      message: msg,
    };
  }

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

async function chatOpenAICompatibleOnce({
  baseUrl,
  apiKey,
  modelId,
  messages,
  maxTokens,
  headers,
  tools,
  reasoningEffort,
  omitReasoning,
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
  // Prefer lowest supported effort; exclude reasoning payload for multi-turn.
  if (isReasoningHeavyModel(modelId) && !omitReasoning) {
    const effort = resolveReasoningEffort(modelId, reasoningEffort);
    if (effort) {
      body.reasoning = {
        effort: effort,
        exclude: true,
      };
    }
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
  if (
    extracted.error &&
    !extracted.text &&
    !(
      extracted.tool_calls &&
      extracted.tool_calls.some((c) => c && !c.parseFailed)
    )
  ) {
    // Allow parseFailed-only tool_calls through so the agent can hard-fail with a repair hint.
    if (
      !(
        extracted.tool_calls &&
        extracted.tool_calls.length &&
        extracted.tool_calls.every((c) => c && c.parseFailed)
      )
    ) {
      throw new Error(extracted.error);
    }
  }
  return {
    response: extracted.text || '',
    raw: data,
    tool_calls: extracted.tool_calls || [],
    finishReason: extracted.finishReason || null,
    reasoning_details: extracted.reasoning_details,
    reasoning: extracted.reasoning,
    error: extracted.error || null,
  };
}

async function chatOpenAICompatible(opts) {
  const ladder = ['low', 'medium', 'high', 'minimal'];
  let effort = resolveReasoningEffort(opts.modelId, opts.reasoningEffort);
  const tried = new Set();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await chatOpenAICompatibleOnce({
        ...opts,
        reasoningEffort: effort,
        omitReasoning: attempt > 0 && !effort,
      });
    } catch (err) {
      if (!isReasoningEffortError(err) || !isReasoningHeavyModel(opts.modelId)) {
        throw err;
      }
      if (effort) tried.add(effort);
      const next = ladder.find((e) => !tried.has(e));
      if (next) {
        effort = resolveReasoningEffort(opts.modelId, next);
        if (tried.has(effort)) effort = next === 'minimal' ? null : next;
        continue;
      }
      if (effort) {
        effort = null;
        continue;
      }
      throw err;
    }
  }
  return chatOpenAICompatibleOnce({ ...opts, reasoningEffort: null, omitReasoning: true });
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

async function groqChat(opts) {
  return chatOpenAICompatible({
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function deepseekChat(opts) {
  return chatOpenAICompatible({
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function modelscopeChat(opts) {
  return chatOpenAICompatible({
    baseUrl:
      process.env.MODELSCOPE_BASE_URL ||
      'https://api-inference.modelscope.cn/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function ollamaChat(opts) {
  return chatOpenAICompatible({
    baseUrl: process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function kiloChat(opts) {
  return chatOpenAICompatible({
    baseUrl: process.env.KILO_BASE_URL || 'https://api.kilo.ai/api/gateway',
    apiKey: opts.apiKey || 'unused',
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function llm7Chat(opts) {
  return chatOpenAICompatible({
    baseUrl: process.env.LLM7_BASE_URL || 'https://api.llm7.io/v1',
    apiKey: opts.apiKey || 'unused',
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function ovhcloudChat(opts) {
  return chatOpenAICompatible({
    baseUrl:
      process.env.OVHCLOUD_BASE_URL ||
      'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    apiKey: opts.apiKey || 'unused',
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function huggingfaceChat(opts) {
  return chatOpenAICompatible({
    baseUrl:
      process.env.HUGGINGFACE_BASE_URL || 'https://router.huggingface.co/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function dashscopeChat(opts) {
  return chatOpenAICompatible({
    baseUrl:
      process.env.DASHSCOPE_BASE_URL ||
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function cloudflareChat(opts) {
  const { parseCloudflareByokKey } = require('./byok-providers');
  const parsed = parseCloudflareByokKey(opts.apiKey);
  if (!parsed.ok) throw new Error(parsed.error);
  return chatOpenAICompatible({
    baseUrl: parsed.baseUrl,
    apiKey: parsed.token,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function mistralChat(opts) {
  return chatOpenAICompatible({
    baseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

async function xaiChat(opts) {
  return chatOpenAICompatible({
    baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    reasoningEffort: opts.reasoningEffort,
  });
}

module.exports = {
  resolveReasoningEffort,
  openrouterChat,
  openaiChat,
  aihubmixChat,
  zaiChat,
  groqChat,
  deepseekChat,
  modelscopeChat,
  ollamaChat,
  kiloChat,
  llm7Chat,
  ovhcloudChat,
  huggingfaceChat,
  dashscopeChat,
  cloudflareChat,
  mistralChat,
  xaiChat,
  chatOpenAICompatible,
  extractOpenAiCompatibleText,
  extractMessageContent,
};
