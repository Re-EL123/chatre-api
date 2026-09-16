'use strict';

const { TOOL_DEFS } = require('./tool-defs');
const { parseModel } = require('./providers/parse');
const {
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
} = require('./providers/openai-compat');
const { anthropicChat } = require('./providers/anthropic');
const { googleChat } = require('./providers/google');
const { cursorChat } = require('./providers/cursor');
const users = require('./users');
const { decrypt, encryptionConfigured } = require('./crypto-secrets');

/**
 * Stream chat from the Cloudflare Worker and emit token deltas.
 */
async function chatWorker({
  messages,
  model,
  maxTokens,
  stream,
  agent,
  mode,
  tools,
}) {
  const base = String(process.env.CHATRE_WORKER_URL || '').replace(/\/$/, '');
  if (!base) {
    throw new Error('CHATRE_WORKER_URL is not configured');
  }
  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.CHATRE_WORKER_SECRET;
  if (secret) {
    headers.Authorization = 'Bearer ' + secret;
    headers['x-chatre-key'] = secret;
  }

  const resolvedMode =
    mode || (agent === false ? 'chat' : agent ? 'agent' : undefined);

  const body = {
    messages,
    stream: stream === true && resolvedMode !== 'analyst' && resolvedMode !== 'critic',
    agent: resolvedMode === 'agent' || (resolvedMode == null && agent !== false),
    mode: resolvedMode,
    model,
    max_tokens: maxTokens || 3072,
  };
  if (tools && tools.length && resolvedMode !== 'analyst' && resolvedMode !== 'critic') {
    body.tools = tools;
    body.stream = false;
  }

  const res = await fetch(base + '/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let err = 'Worker chat failed (' + res.status + ')';
    try {
      const j = await res.json();
      if (j && j.error) err = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(err);
  }

  if (stream && !tools && resolvedMode !== 'analyst' && resolvedMode !== 'critic') return res;
  const data = await res.json();
  return data;
}

function extractStreamTokens(chunk, carry) {
  const combined = carry + chunk;
  const lines = combined.split('\n');
  const nextCarry = lines.pop() || '';
  let text = '';
  for (let line of lines) {
    line = line.trim();
    if (!line || line === 'data: [DONE]' || line === '[DONE]') continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (!line || line === '[DONE]') continue;
    try {
      const json = JSON.parse(line);
      if (typeof json.response === 'string') text += json.response;
      else if (typeof json.text === 'string') text += json.text;
      else if (typeof json.token === 'string') text += json.token;
    } catch {
      /* ignore */
    }
  }
  return { text, carry: nextCarry };
}

async function resolveApiKey(userId, provider) {
  if (provider === 'chatre') return null;
  if (!userId) throw new Error('BYOK requires a signed-in user');
  if (!encryptionConfigured()) {
    throw new Error('BYOK_ENCRYPTION_KEY is not configured');
  }
  const doc = await users.getByokDoc(userId);
  const blob = doc && doc[provider];
  if (!blob) {
    // Free anonymous OpenAI-compatible gateways accept a placeholder.
    if (provider === 'kilo' || provider === 'llm7' || provider === 'ovhcloud') {
      return 'unused';
    }
    throw new Error(
      'No API key saved for ' + provider + '. Add it in Settings → BYOK.',
    );
  }
  return decrypt(blob);
}

async function chatViaProvider({
  provider,
  modelId,
  messages,
  maxTokens,
  apiKey,
  tools,
}) {
  const p = String(provider || '').toLowerCase().trim();
  const handlers = {
    openrouter: () =>
      openrouterChat({ apiKey, modelId, messages, maxTokens, tools }),
    openai: () => openaiChat({ apiKey, modelId, messages, maxTokens, tools }),
    aihubmix: () =>
      aihubmixChat({ apiKey, modelId, messages, maxTokens, tools }),
    zai: () => zaiChat({ apiKey, modelId, messages, maxTokens, tools }),
    groq: () => groqChat({ apiKey, modelId, messages, maxTokens, tools }),
    deepseek: () =>
      deepseekChat({ apiKey, modelId, messages, maxTokens, tools }),
    modelscope: () =>
      modelscopeChat({ apiKey, modelId, messages, maxTokens, tools }),
    ollama: () => ollamaChat({ apiKey, modelId, messages, maxTokens, tools }),
    kilo: () => kiloChat({ apiKey, modelId, messages, maxTokens, tools }),
    llm7: () => llm7Chat({ apiKey, modelId, messages, maxTokens, tools }),
    ovhcloud: () =>
      ovhcloudChat({ apiKey, modelId, messages, maxTokens, tools }),
    huggingface: () =>
      huggingfaceChat({ apiKey, modelId, messages, maxTokens, tools }),
    dashscope: () =>
      dashscopeChat({ apiKey, modelId, messages, maxTokens, tools }),
    cloudflare: () =>
      cloudflareChat({ apiKey, modelId, messages, maxTokens, tools }),
    mistral: () =>
      mistralChat({ apiKey, modelId, messages, maxTokens, tools }),
    xai: () => xaiChat({ apiKey, modelId, messages, maxTokens, tools }),
    anthropic: () =>
      // No native tool schemas yet — ```tool text protocol only.
      anthropicChat({ apiKey, modelId, messages, maxTokens }),
    google: () => googleChat({ apiKey, modelId, messages, maxTokens }),
    cursor: () =>
      // Cloud Agents API has no OpenAI tool schema — Chatre uses ```tool text protocol.
      cursorChat({ apiKey, modelId, messages }),
  };
  const run = handlers[p];
  if (!run) {
    throw new Error(
      'Unknown provider: ' +
        provider +
        '. Supported: ' +
        Object.keys(handlers).join(', '),
    );
  }
  return run();
}

/**
 * Unified entry used by agent — routes Chatre Worker vs BYOK providers.
 */
async function chatRouted(opts) {
  const { provider, modelId } = parseModel(opts.model);
  if (provider === 'chatre') {
    return chatWorker({
      ...opts,
      model: modelId,
    });
  }
  const apiKey = await resolveApiKey(opts.userId, provider);
  return chatViaProvider({
    provider,
    modelId,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    apiKey,
    tools: opts.tools,
  });
}

async function chatWorkerStreaming({
  messages,
  model,
  maxTokens,
  agent,
  onToken,
  userId,
}) {
  const { provider, modelId } = parseModel(model);
  if (provider !== 'chatre') {
    const data = await chatRouted({
      messages,
      model,
      maxTokens,
      userId,
      agent: false,
    });
    const text = data.response || data.text || '';
    if (text && onToken) {
      const chunk = 24;
      for (let i = 0; i < text.length; i += chunk) onToken(text.slice(i, i + chunk));
    }
    return text;
  }

  let res;
  try {
    res = await chatWorker({
      messages,
      model: modelId,
      maxTokens,
      stream: true,
      agent,
    });
  } catch (err) {
    if (isWorkersQuotaError(err)) {
      const fallback = await resolveByokFallbackModel(userId, model);
      if (fallback) {
        const data = await chatRouted({
          messages,
          model: fallback,
          maxTokens,
          userId,
          agent: false,
        });
        const text = data.response || data.text || '';
        if (text && onToken) {
          const chunk = 24;
          for (let i = 0; i < text.length; i += chunk) onToken(text.slice(i, i + chunk));
        }
        return text;
      }
    }
    throw err;
  }

  if (!res || !res.body) {
    const data = res && typeof res === 'object' && !res.body ? res : {};
    const text = data.response || '';
    if (text && onToken) onToken(text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const parsed = extractStreamTokens(chunk, carry);
    carry = parsed.carry;
    if (parsed.text) {
      full += parsed.text;
      if (onToken) onToken(parsed.text);
    }
  }

  if (carry.trim()) {
    try {
      const maybe = JSON.parse(carry.trim());
      if (typeof maybe.response === 'string' && !full) {
        full = maybe.response;
        if (onToken) onToken(full);
      } else {
        const parsed = extractStreamTokens(carry + '\n', '');
        if (parsed.text) {
          full += parsed.text;
          if (onToken) onToken(parsed.text);
        }
      }
    } catch {
      const parsed = extractStreamTokens(carry + '\n', '');
      if (parsed.text) {
        full += parsed.text;
        if (onToken) onToken(parsed.text);
      }
    }
  }

  return full;
}

function isWorkersQuotaError(err) {
  const msg = String((err && err.message) || err || '');
  return /neurons|quota exhausted|Workers AI free|httpCode\":\s*429|\b429\b/i.test(msg);
}

/** Quota / rate-limit / billing / retired-model — try another provider before scaffolding. */
function isProviderQuotaError(err) {
  const msg = String((err && err.message) || err || '');
  return (
    isWorkersQuotaError(err) ||
    /rate limit|quota|RESOURCE_EXHAUSTED|exceeded your current quota|free_tier|Retry after|billing|no credits|doesn't have any credits|retired|model_not_found|is not available|license/i.test(
      msg,
    )
  );
}

async function resolveByokFallbackModel(userId, currentModel) {
  if (!userId) return null;
  const { provider } = parseModel(currentModel);
  if (provider !== 'chatre') return null;
  try {
    const { preferByokModel } = require('./autonomy');
    const byokDoc = await users.getByokDoc(userId);
    const flags = users.byokConfiguredFlags(byokDoc);
    const profile = await users.ensureUser(userId, '');
    const next = preferByokModel(
      currentModel || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      flags,
      profile.defaults || {},
    );
    if (!next || parseModel(next).provider === 'chatre') return null;
    return next;
  } catch {
    return null;
  }
}

/** Prefer an alternate configured BYOK provider when the active one is rate-limited. */
async function resolveAlternateByokModel(userId, currentModel) {
  if (!userId) return null;
  try {
    const { preferByokModel } = require('./autonomy');
    const byokDoc = await users.getByokDoc(userId);
    const flags = users.byokConfiguredFlags(byokDoc);
    const profile = await users.ensureUser(userId, '');
    const cur = parseModel(currentModel);
    // Temporarily clear the failing provider flag so preferByokModel picks another.
    const masked = Object.assign({}, flags, { [cur.provider]: false });
    const next = preferByokModel(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      masked,
      profile.defaults || {},
    );
    if (!next) return null;
    const n = parseModel(next);
    if (n.provider === cur.provider) return null;
    return next;
  } catch {
    return null;
  }
}

function affordableTokensFromError(err) {
  const msg = String((err && err.message) || err || '');
  const m = msg.match(/can only afford\s+(\d+)/i);
  if (m) return Math.max(0, Number(m[1]) || 0);
  if (/exceed your available credits|more credits|in-flight requests/i.test(msg)) {
    return 256;
  }
  return null;
}

function isCreditError(err) {
  const msg = String((err && err.message) || err || '');
  return /credits|can only afford|max_tokens/i.test(msg) || isProviderQuotaError(err);
}

async function chatWorkerWithTools({
  messages,
  model,
  maxTokens,
  agent,
  onToken,
  tools,
  userId,
}) {
  const { provider, modelId } = parseModel(model);
  let data;
  if (provider === 'chatre') {
    try {
      data = await chatWorker({
        messages,
        model: modelId,
        maxTokens,
        stream: false,
        agent,
        tools: tools === undefined ? TOOL_DEFS : tools,
      });
    } catch (err) {
      if (isWorkersQuotaError(err)) {
        const fallback = await resolveByokFallbackModel(userId, model);
        if (fallback) {
          data = await chatRouted({
            messages,
            model: fallback,
            maxTokens: maxTokens || 1600,
            userId,
            agent: true,
            tools: tools === undefined ? TOOL_DEFS : tools,
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
  } else {
    // BYOK: pass native tools when the provider supports them; always keep
    // text ```tool protocol in the message stack as fallback.
    // Cursor / Anthropic / Google: omit OpenAI tool schemas (```tool only).
    // Explicit [] means no tools this turn (max-steps hard stop).
    const requested = maxTokens || 1600;
    const resolvedTools = tools === undefined ? TOOL_DEFS : tools;
    const passTools =
      provider === 'cursor' ||
      provider === 'anthropic' ||
      provider === 'google'
        ? undefined
        : resolvedTools;
    try {
      data = await chatRouted({
        messages,
        model,
        maxTokens: requested,
        userId,
        agent: true,
        tools: passTools,
      });
    } catch (err) {
      // Too little budget / schema rejection → retry without tool schemas (```tool text).
      const afford = affordableTokensFromError(err);
      if (afford != null && afford < 700) {
        const e = new Error(
          'OpenRouter credits too low for tool calls (afford ~' +
            afford +
            ' tokens). Add credits or use a Chatre/Workers model.',
        );
        e.code = 'CREDITS';
        e.afford = afford;
        throw e;
      }
      if (isProviderQuotaError(err)) {
        const alt =
          (await resolveAlternateByokModel(userId, model)) ||
          (provider === 'chatre'
            ? await resolveByokFallbackModel(userId, model)
            : '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
        if (alt && alt !== model) {
          try {
            data = await chatRouted({
              messages,
              model: alt,
              maxTokens: requested,
              userId,
              agent: true,
              tools: passTools,
            });
          } catch (errAlt) {
            // Fall through to text-tool protocol on original model
            data = null;
          }
        }
      }
      if (!data && afford != null) {
        const budget = Math.max(64, Math.min(requested, afford - 24));
        try {
          data = await chatRouted({
            messages,
            model,
            maxTokens: budget,
            userId,
            agent: true,
            tools: passTools,
          });
        } catch (err2) {
          const e = new Error(
            'OpenRouter credits too low for this run (afford ~' +
              afford +
              ' tokens). Add credits at https://openrouter.ai/settings/credits or switch to a Chatre/Workers model. ' +
              String(err2.message || err2),
          );
          e.code = 'CREDITS';
          e.afford = afford;
          throw e;
        }
      }
      if (!data) {
        // Some models reject large tool schemas — fall back to ```tool text protocol.
        data = await chatRouted({
          messages,
          model,
          maxTokens: requested,
          userId,
          agent: true,
        });
      }
    }
  }

  const text = typeof data === 'string' ? data : data.response || data.text || '';
  if (text && onToken) {
    const chunk = 24;
    for (let i = 0; i < text.length; i += chunk) {
      onToken(text.slice(i, i + chunk));
    }
  }

  const toolCalls =
    (data && (data.tool_calls || data.toolCalls)) || [];

  return {
    text,
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
    raw: data,
  };
}

/** Patch chatWorker export to route when model has provider prefix */
const _chatWorker = chatWorker;
async function chatWorkerExport(opts) {
  const { provider } = parseModel(opts.model);
  if (provider === 'chatre') return _chatWorker(opts);
  return chatRouted(opts);
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

module.exports = {
  chatWorker: chatWorkerExport,
  chatWorkerStreaming,
  chatWorkerWithTools,
  chatRouted,
  parseModel,
  estimateTokens,
  affordableTokensFromError,
  isCreditError,
  isProviderQuotaError,
  resolveAlternateByokModel,
  TOOL_DEFS,
};
