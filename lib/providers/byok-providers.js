'use strict';

/**
 * Canonical BYOK provider ids (OpenAI-compatible + specialized).
 * Keep FE regexes / Settings dropdowns in sync when changing this list.
 */

const BYOK_PROVIDER_IDS = [
  'openrouter',
  'aihubmix',
  'zai',
  'groq',
  'deepseek',
  'modelscope',
  'mistral',
  'xai',
  'anthropic',
  'openai',
  'google',
  'cursor',
  'ollama',
  'kilo',
  'cloudflare',
  'llm7',
  'ovhcloud',
  'huggingface',
  'dashscope',
];

/** Prefix regex source for model strings like `ollama:gpt-oss:120b`. */
const BYOK_PROVIDER_PREFIX_SRC = BYOK_PROVIDER_IDS.join('|');

function isByokProvider(id) {
  return BYOK_PROVIDER_IDS.includes(String(id || '').toLowerCase());
}

/**
 * Cloudflare Workers AI OpenAI path needs account id in the URL.
 * Accepted key formats:
 *   - accountId:apiToken  (32-hex account id)
 *   - accountId|apiToken
 */
function parseCloudflareByokKey(raw) {
  const key = String(raw || '').trim();
  let accountId = '';
  let token = '';
  const colon = key.match(/^([a-f0-9]{32})[:|](.+)$/i);
  if (colon) {
    accountId = colon[1];
    token = colon[2].trim();
  } else if (process.env.CLOUDFLARE_ACCOUNT_ID && key.length >= 16) {
    accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID).trim();
    token = key;
  }
  if (!accountId || !token) {
    return {
      ok: false,
      error:
        'Cloudflare Workers AI key must be accountId:apiToken (32-char account id from the dashboard + API token).',
    };
  }
  return {
    ok: true,
    accountId,
    token,
    baseUrl:
      (process.env.CLOUDFLARE_AI_BASE_URL ||
        'https://api.cloudflare.com/client/v4/accounts') +
      '/' +
      accountId +
      '/ai/v1',
  };
}

module.exports = {
  BYOK_PROVIDER_IDS,
  BYOK_PROVIDER_PREFIX_SRC,
  isByokProvider,
  parseCloudflareByokKey,
};
