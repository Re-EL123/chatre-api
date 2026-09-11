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

const PING = [
  { role: 'user', content: 'Reply with exactly: ok' },
];

async function testByokProvider(uid, provider) {
  const p = String(provider || '').toLowerCase();
  if (!['openrouter', 'anthropic', 'openai', 'google'].includes(p)) {
    return { ok: false, error: 'Unknown provider: ' + provider };
  }
  if (!encryptionConfigured()) {
    return { ok: false, error: 'BYOK_ENCRYPTION_KEY is not configured' };
  }
  const doc = await users.getByokDoc(uid);
  const blob = doc && doc[p];
  if (!blob || !blob.ciphertext) {
    return { ok: false, error: 'No key saved for ' + p };
  }
  let apiKey;
  try {
    apiKey = decrypt(blob);
  } catch (err) {
    return { ok: false, error: 'Decrypt failed' };
  }

  try {
    let result;
    if (p === 'openrouter') {
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
        modelId: 'gemini-2.0-flash',
        messages: PING,
        maxTokens: 8,
      });
    }
    const text =
      (result && (result.response || result.text || result.content)) || '';
    return {
      ok: true,
      provider: p,
      connected: true,
      sample: String(text).slice(0, 80),
    };
  } catch (err) {
    return {
      ok: false,
      provider: p,
      connected: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

module.exports = { testByokProvider };
