'use strict';

/**
 * Probe a saved BYOK provider key with a minimal chat request.
 */

const users = require('./users');
const { decrypt, encryptionConfigured } = require('./crypto-secrets');
const { openrouterChat } = require('./providers/openai-compat');
const { openaiChat } = require('./providers/openai-compat');
const { anthropicChat } = require('./providers/anthropic');
const { googleChat } = require('./providers/google');

const PING = [{ role: 'user', content: 'Reply with exactly: ok' }];

const PROVIDERS = ['openrouter', 'anthropic', 'openai', 'google'];

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
  if (!key || key.length < 8) {
    return { ok: false, error: 'API key looks empty or too short' };
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
  const p = String(provider || '').toLowerCase();
  if (!PROVIDERS.includes(p)) {
    return { ok: false, error: 'Unknown provider: ' + provider };
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
        modelId: 'openai/gpt-4o-mini',
        messages: PING,
        maxTokens: 8,
      });
    } else if (p === 'openai') {
      result = await openaiChat({
        apiKey,
        modelId: 'gpt-4o-mini',
        messages: PING,
        maxTokens: 8,
      });
    } else if (p === 'anthropic') {
      result = await anthropicChat({
        apiKey,
        modelId: 'claude-3-5-haiku-latest',
        messages: PING,
        maxTokens: 8,
      });
    } else {
      result = await googleChat({
        apiKey,
        modelId: 'gemini-3.6-flash',
        messages: PING,
        maxTokens: 8,
      });
    }
    const text =
      (result && (result.response || result.text || result.content)) || '';
    const fp = keyFingerprint(apiKey);
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
