'use strict';

/**
 * Probe a saved BYOK provider key with a minimal chat request.
 */

const users = require('./users');
const { decrypt, encryptionConfigured } = require('./crypto-secrets');
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
const { cursorMe, listCursorModels, normalizeCursorKey } = require('./providers/cursor');
const { BYOK_PROVIDER_IDS, parseCloudflareByokKey } = require('./providers/byok-providers');

const PING = [{ role: 'user', content: 'Reply with exactly: ok' }];

const PROVIDERS = BYOK_PROVIDER_IDS;

function normalizeApiKey(raw) {
  let key = String(raw || '')
    // Strip BOM / zero-width / non-printable junk from rich-text paste.
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  if (!key) return '';
  // Users sometimes paste "Bearer sk-…" or quoted values.
  if (/^bearer\s+/i.test(key)) key = key.replace(/^bearer\s+/i, '').trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key.replace(/\s+/g, '');
}

function keyFingerprint(apiKey) {
  const key = normalizeApiKey(apiKey);
  if (!key) return { preview: '(empty)', length: 0 };
  const prefix = key.slice(0, Math.min(10, key.length));
  const suffix = key.length > 4 ? key.slice(-4) : '';
  return {
    preview: prefix + '…' + suffix,
    length: key.length,
  };
}

function validateProviderKey(provider, apiKey) {
  const p = String(provider || '').toLowerCase();
  const key = normalizeApiKey(apiKey);
  // Kilo / LLM7 / OVHcloud allow anonymous or placeholder keys for free tiers.
  const anonOk = p === 'kilo' || p === 'llm7' || p === 'ovhcloud';
  if (!key || (!anonOk && key.length < 8)) {
    return { ok: false, error: 'API key looks empty or too short' };
  }
  if (anonOk && key.length < 6 && !/^(unused|anon|anonymous|free)$/i.test(key)) {
    return {
      ok: false,
      error:
        'Paste a provider token, or use "unused" for the anonymous free tier.',
    };
  }
  if (p === 'openrouter') {
    if (!/^sk-or-v1-/i.test(key)) {
      return {
        ok: false,
        error:
          'OpenRouter keys look like sk-or-v1-…. This value does not. Pick the matching provider or paste a key from https://openrouter.ai/keys',
      };
    }
    if (key.length < 40) {
      return {
        ok: false,
        error:
          'OpenRouter key looks truncated (length ' +
          key.length +
          '). Paste the full key from https://openrouter.ai/keys',
      };
    }
  }
  if (p === 'aihubmix') {
    if (!/^sk-/i.test(key)) {
      return {
        ok: false,
        error:
          'AIHubMix keys usually start with sk-. Create one at https://console.aihubmix.com/token',
      };
    }
    if (key.length < 20) {
      return {
        ok: false,
        error:
          'AIHubMix key looks truncated. Paste the full key from https://console.aihubmix.com/token',
      };
    }
  }
  if (p === 'zai') {
    if (key.length < 16) {
      return {
        ok: false,
        error:
          'Z.ai API key looks too short. Create one at https://z.ai/manage-apikey or via https://chat.z.ai/',
      };
    }
  }
  if (p === 'groq') {
    if (!/^gsk_/i.test(key)) {
      return {
        ok: false,
        error:
          'Groq keys usually start with gsk_. Create one at https://console.groq.com/keys',
      };
    }
  }
  if (p === 'deepseek') {
    if (!/^sk-/i.test(key)) {
      return {
        ok: false,
        error:
          'DeepSeek keys usually start with sk-. Create one at https://platform.deepseek.com/api_keys',
      };
    }
  }
  if (p === 'modelscope') {
    if (key.length < 16) {
      return {
        ok: false,
        error:
          'ModelScope SDK token looks too short. Create one at https://modelscope.cn/my/myaccesstoken',
      };
    }
  }
  if (p === 'ollama' && key.length < 12) {
    return {
      ok: false,
      error:
        'Ollama Cloud API key looks too short. Create one at https://ollama.com/settings/keys',
    };
  }
  if (p === 'kilo' && key.length < 6) {
    return {
      ok: false,
      error:
        'Kilo Code key looks too short. Create one at https://app.kilo.ai/profile (or save "unused" for free models).',
    };
  }
  if (p === 'llm7' && key.length < 6) {
    return {
      ok: false,
      error:
        'LLM7 token looks too short. Get a free token at https://token.llm7.io (or save "unused" for anonymous).',
    };
  }
  if (p === 'ovhcloud' && key.length < 6) {
    return {
      ok: false,
      error:
        'OVHcloud AI Endpoints token looks too short. Create one in the OVHcloud console (or save "unused" for anonymous).',
    };
  }
  if (p === 'huggingface') {
    if (!/^hf_/i.test(key) && key.length < 16) {
      return {
        ok: false,
        error:
          'Hugging Face tokens usually start with hf_. Create one at https://huggingface.co/settings/tokens (enable Inference Providers).',
      };
    }
  }
  if (p === 'dashscope') {
    if (!/^sk-/i.test(key) && key.length < 16) {
      return {
        ok: false,
        error:
          'Alibaba Model Studio (DashScope) keys usually start with sk-. Create one in the Model Studio console.',
      };
    }
  }
  if (p === 'cloudflare') {
    const parsed = parseCloudflareByokKey(key);
    if (!parsed.ok) return parsed;
  }
  if (p === 'mistral' && key.length < 16) {
    return {
      ok: false,
      error:
        'Mistral key looks too short. Create one at https://console.mistral.ai/api-keys',
    };
  }
  if (p === 'xai') {
    if (!/^xai-/i.test(key) && !/^sk-/i.test(key)) {
      return {
        ok: false,
        error:
          'xAI keys usually start with xai-. Create one at https://console.x.ai/',
      };
    }
  }
  if (p === 'openai' && !/^sk-/i.test(key)) {
    return {
      ok: false,
      error: 'OpenAI keys usually start with sk-. Check the provider dropdown matches the key.',
    };
  }
  if (p === 'anthropic' && !/^sk-ant-/i.test(key)) {
    return {
      ok: false,
      error:
        'Anthropic keys start with sk-ant-. Check the provider dropdown matches the key.',
    };
  }
  if (p === 'google' && /^sk-/i.test(key)) {
    return {
      ok: false,
      error:
        'That looks like an OpenAI/OpenRouter key. Google Gemini needs an AI Studio / Generative Language API key.',
    };
  }
  if (p === 'cursor') {
    if (key.length < 20) {
      return {
        ok: false,
        error:
          'Cursor API key looks truncated. Paste the full key from https://cursor.com/dashboard/api (often crsr_…).',
      };
    }
    if (/^(sk-or-v1-|sk-ant-|sk-proj-|gsk_)/i.test(key)) {
      return {
        ok: false,
        error:
          'That looks like another provider\'s key. Cursor keys come from https://cursor.com/dashboard/api — pick Cursor in the provider dropdown.',
      };
    }
  }
  return { ok: true, key };
}

function mapProviderError(provider, err, apiKey) {
  const raw = err instanceof Error ? err.message : String(err || '');
  const msg = raw.replace(/^Error:\s*/i, '').trim();
  const lower = msg.toLowerCase();
  const fp = keyFingerprint(apiKey);
  const fpNote =
    fp.length > 0
      ? ' (using ' + fp.preview + ', length ' + fp.length + ')'
      : '';
  if (
    provider === 'openrouter' &&
    (lower.includes('user not found') || lower === 'unauthorized')
  ) {
    return (
      'OpenRouter does not recognize this API key' +
      fpNote +
      '. It is invalid, revoked, or incomplete — not a Chatre account error. Create a new key at https://openrouter.ai/keys, paste the full sk-or-v1-… value into BYOK, Save, then Test.'
    );
  }
  if (lower.includes('incorrect api key') || lower.includes('invalid api key')) {
    return (
      'Provider rejected the API key' +
      fpNote +
      '. Re-paste the key for the selected provider and save again.'
    );
  }
  if (lower.includes('invalid x-api-key')) {
    return 'Anthropic rejected the API key. Use a key that starts with sk-ant- under the Anthropic provider.';
  }
  if (provider === 'cursor') {
    if (
      lower.includes('unauthorized') ||
      lower.includes('invalid api key') ||
      lower.includes('401')
    ) {
      return (
        'Cursor rejected this API key' +
        fpNote +
        '. Create a user API key at https://cursor.com/dashboard/api (Cloud Agents), paste under BYOK → Cursor, Save, then Test.'
      );
    }
    if (lower.includes('invalid_model') || lower.includes('rejected model')) {
      return (
        msg +
        ' Refresh the model list after saving the Cursor key, or pick cursor:composer-2.5.'
      );
    }
  }
  return (msg || 'Provider connection failed') + fpNote;
}

async function resolveApiKey(uid, provider, overrideKey) {
  if (overrideKey) {
    const checked = validateProviderKey(provider, overrideKey);
    if (!checked.ok) return checked;
    return { ok: true, key: checked.key, source: 'provided' };
  }
  if (!encryptionConfigured()) {
    return { ok: false, error: 'BYOK_ENCRYPTION_KEY is not configured' };
  }
  const doc = await users.getByokDoc(uid);
  const blob = doc && doc[provider];
  if (!blob || !blob.ciphertext) {
    return { ok: false, error: 'No key saved for ' + provider + '. Save a key first, then Test.' };
  }
  let apiKey;
  try {
    apiKey = decrypt(blob);
  } catch (err) {
    return {
      ok: false,
      error:
        'Could not decrypt the saved key (server encryption key may have changed). Remove and re-save the key.',
    };
  }
  const checked = validateProviderKey(provider, apiKey);
  if (!checked.ok) return checked;
  return { ok: true, key: checked.key, source: 'saved' };
}

async function testByokProvider(uid, provider, overrideKey) {
  const p = String(provider || '').toLowerCase().trim();
  if (!PROVIDERS.includes(p)) {
    return {
      ok: false,
      error:
        'Unknown provider: ' +
        provider +
        '. Supported: ' +
        PROVIDERS.join(', '),
    };
  }

  const resolved = await resolveApiKey(uid, p, overrideKey);
  if (!resolved.ok) return resolved;
  const apiKey = resolved.key;

  try {
    let result;
    if (p === 'openrouter') {
      // Official current-key probe: https://openrouter.ai/api/v1/key
      const authRes = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: 'Bearer ' + apiKey },
      });
      const authBody = await authRes.json().catch(() => ({}));
      if (!authRes.ok) {
        const authMsg =
          (authBody && authBody.error && (authBody.error.message || authBody.error)) ||
          'OpenRouter auth failed ' + authRes.status;
        throw new Error(String(authMsg));
      }
      result = await openrouterChat({
        apiKey,
        modelId: 'openrouter/free',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'aihubmix') {
      result = await aihubmixChat({
        apiKey,
        modelId: 'gpt-4o-mini',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'zai') {
      result = await zaiChat({
        apiKey,
        modelId: 'glm-5.3-flash',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'groq') {
      result = await groqChat({
        apiKey,
        modelId: 'openai/gpt-oss-20b',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'deepseek') {
      result = await deepseekChat({
        apiKey,
        modelId: 'deepseek-chat',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'modelscope') {
      result = await modelscopeChat({
        apiKey,
        modelId: 'Qwen/Qwen2.5-Coder-32B-Instruct',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'ollama') {
      result = await ollamaChat({
        apiKey,
        modelId: 'gpt-oss:20b',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'kilo') {
      result = await kiloChat({
        apiKey,
        modelId: 'kilo-auto/free',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'llm7') {
      result = await llm7Chat({
        apiKey,
        modelId: 'fast',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'ovhcloud') {
      result = await ovhcloudChat({
        apiKey,
        modelId: 'Meta-Llama-3_3-70B-Instruct',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'huggingface') {
      result = await huggingfaceChat({
        apiKey,
        modelId: 'openai/gpt-oss-120b:fastest',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'dashscope') {
      result = await dashscopeChat({
        apiKey,
        modelId: 'qwen-plus',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'cloudflare') {
      result = await cloudflareChat({
        apiKey,
        modelId: '@cf/meta/llama-3.1-8b-instruct',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'mistral') {
      result = await mistralChat({
        apiKey,
        modelId: 'mistral-small-latest',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'xai') {
      result = await xaiChat({
        apiKey,
        modelId: 'grok-3-mini',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'openai') {
      result = await openaiChat({
        apiKey,
        modelId: 'gpt-4o-mini',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'anthropic') {
      result = await anthropicChat({
        apiKey,
        modelId: 'claude-3-5-haiku-latest',
        messages: PING,
        maxTokens: 64,
      });
    } else if (p === 'google') {
      result = await googleChat({
        apiKey,
        modelId: 'gemini-3.8-flash',
        messages: PING,
        maxTokens: 256,
        // resolveThinkingLevel picks lowest supported (low for 3.8)
      });
    } else if (p === 'cursor') {
      const key = normalizeCursorKey(apiKey);
      const me = await cursorMe(key);
      let modelNote = '';
      try {
        const models = await listCursorModels(key);
        if (models && models.length) {
          modelNote =
            '; ' +
            models.length +
            ' models (e.g. ' +
            models
              .slice(0, 2)
              .map((m) => m.id)
              .join(', ') +
            ')';
        }
      } catch {
        /* me alone is enough for auth */
      }
      result = {
        response:
          'ok' +
          (me && me.userEmail
            ? ' (' + me.userEmail + ')'
            : me && me.apiKeyName
              ? ' (' + me.apiKeyName + ')'
              : '') +
          modelNote,
      };
    } else {
      throw new Error('Unsupported provider: ' + p);
    }
    const text =
      (result && (result.response || result.text || result.content)) || '';
    const fp = keyFingerprint(apiKey);
    if (!String(text).trim()) {
      const hints = {
        google:
          'Key accepted but the model returned empty text. Gemini 3.x needs enough output tokens for thinking — retry Test connection.',
        openrouter:
          'Key accepted but the model returned empty text. Reasoning/Gemini models via OpenRouter can burn the token budget on thinking — retry, or pick openai/gpt-4o-mini.',
        aihubmix:
          'Key accepted but the model returned empty text. Retry Test, or try model gpt-4o-mini on AIHubMix.',
        zai:
          'Key accepted but the model returned empty text. Retry Test, or try glm-5.3-flash on Z.ai.',
        groq:
          'Key accepted but the model returned empty text. Retry Test, or try openai/gpt-oss-20b.',
        deepseek:
          'Key accepted but the model returned empty text. Retry Test with deepseek-chat.',
        modelscope:
          'Key accepted but the model returned empty text. Retry Test, or try Qwen/Qwen2.5-Coder-32B-Instruct on ModelScope.',
        ollama:
          'Key accepted but the model returned empty text. Retry Test with gpt-oss:20b on Ollama Cloud.',
        kilo:
          'Key accepted but the model returned empty text. Retry Test with kilo-auto/free.',
        llm7:
          'Key accepted but the model returned empty text. Retry Test with model fast on LLM7.',
        ovhcloud:
          'Key accepted but the model returned empty text. Retry Test with Meta-Llama-3_3-70B-Instruct.',
        huggingface:
          'Key accepted but the model returned empty text. Ensure the token allows Inference Providers; retry openai/gpt-oss-120b:fastest.',
        dashscope:
          'Key accepted but the model returned empty text. Retry Test with qwen-plus (use DASHSCOPE_BASE_URL for China region).',
        cloudflare:
          'Key accepted but the model returned empty text. Confirm accountId:apiToken and Workers AI permissions on the token.',
        mistral:
          'Key accepted but the model returned empty text. Retry Test with mistral-small-latest.',
        xai:
          'Key accepted but the model returned empty text. Retry Test with grok-3-mini.',
        openai:
          'Key accepted but the model returned empty text. Retry Test connection.',
        cursor:
          'Key accepted but Cursor returned empty text. Retry Test, or check https://cursor.com/dashboard/api.',
        anthropic:
          'Key accepted but the model returned empty text. Retry Test connection.',
      };
      return {
        ok: false,
        provider: p,
        connected: false,
        error: hints[p] || 'Provider returned empty text on probe.',
        source: resolved.source,
        keyPreview: fp.preview,
        keyLength: fp.length,
      };
    }
    return {
      ok: true,
      provider: p,
      connected: true,
      sample: String(text).slice(0, 80),
      source: resolved.source,
      keyPreview: fp.preview,
      keyLength: fp.length,
    };
  } catch (err) {
    const fp = keyFingerprint(apiKey);
    return {
      ok: false,
      provider: p,
      connected: false,
      error: mapProviderError(p, err, apiKey),
      source: resolved.source,
      keyPreview: fp.preview,
      keyLength: fp.length,
    };
  }
}

module.exports = {
  testByokProvider,
  normalizeApiKey,
  validateProviderKey,
  PROVIDERS,
};
