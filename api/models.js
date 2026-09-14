'use strict';

const { handleCors } = require('../lib/cors');
const { sendJson, requireAuth } = require('../lib/http');
const users = require('../lib/users');

const CHATRE_MODELS = [
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Llama 3.3 70B (default)',
    provider: 'chatre',
  },
  {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    label: 'Llama 3.1 8B Fast',
    provider: 'chatre',
  },
  {
    id: '@cf/meta/llama-3.1-8b-instruct',
    label: 'Llama 3.1 8B',
    provider: 'chatre',
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    label: 'Llama 3.2 3B',
    provider: 'chatre',
  },
];

// Live free catalog changes; IDs verified against OpenRouter /api/v1/models.
const OPENROUTER_FREE_SUGGESTIONS = [
  'openrouter/free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'cohere/north-mini-code:free',
  'nex-agi/nex-n2.5-pro:free',
  'nex-agi/nex-n2.5-mini:free',
  'liquid/lfm-2.5-2.6b:free',
  'inclusionai/ling-3.0-flash-fin:free',
];

const OPENROUTER_PAID_SUGGESTIONS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-sonnet-4',
  'google/gemini-2.5-flash',
  'meta-llama/llama-3.3-70b-instruct',
];

const OPENROUTER_SUGGESTIONS = OPENROUTER_FREE_SUGGESTIONS.concat(
  OPENROUTER_PAID_SUGGESTIONS,
);

const ANTHROPIC_SUGGESTIONS = [
  'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
];

const OPENAI_SUGGESTIONS = ['gpt-4o-mini', 'gpt-4o', 'o4-mini'];

/** Chat-capable Gemini IDs (Google AI Studio / generativelanguage API). */
const GOOGLE_SUGGESTIONS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

const GOOGLE_LABELS = {
  'gemini-3.8-flash': 'Gemini 3.8 Flash (latest)',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro (preview)',
  'gemini-3-flash-preview': 'Gemini 3 Flash (preview)',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
};

const CURSOR_SUGGESTIONS = [
  'composer-2.5',
  'composer-2',
  'composer-1.5',
];
const CURSOR_LABELS = {
  'composer-2.5': 'Composer 2.5',
  'composer-2': 'Composer 2',
  'composer-1.5': 'Composer 1.5',
};


const AIHUBMIX_SUGGESTIONS = [
  'gpt-4o-mini',
  'gpt-4o',
  'claude-3-5-sonnet-latest',
  'claude-sonnet-4-20250514',
  'gemini-3.8-flash',
  'gemini-2.5-flash',
  'deepseek-v3',
];

const ZAI_SUGGESTIONS = [
  'glm-5.3-flash',
  'glm-5.3',
  'glm-4.7',
  'glm-4.6',
];

const GROQ_SUGGESTIONS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b',
  'groq/compound',
];

const DEEPSEEK_SUGGESTIONS = ['deepseek-chat', 'deepseek-reasoner'];

const MODELSCOPE_SUGGESTIONS = [
  'Qwen/Qwen2.5-Coder-32B-Instruct',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'Qwen/Qwen3-30B-A3B-Instruct-2507',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'ZhipuAI/GLM-4.6',
  'ZhipuAI/GLM-4.5',
  'deepseek-ai/DeepSeek-R1',
];

const OLLAMA_SUGGESTIONS = [
  'gpt-oss:20b',
  'gpt-oss:120b',
  'deepseek-v3.1:671b',
  'qwen3-coder:480b',
  'kimi-k2:1t',
];

const KILO_SUGGESTIONS = [
  'kilo-auto/free',
  'nvidia/nemotron-3.5-lightning:free',
  'stepfun/step-3.7-flash:free',
  'poolside/laguna-s-2.1:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/free',
];

const CLOUDFLARE_SUGGESTIONS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/google/gemma-3-12b-it',
];

const LLM7_SUGGESTIONS = ['fast', 'default', 'gpt-oss:20b', 'minimax-m2.7'];

const OVHCLOUD_SUGGESTIONS = [
  'Meta-Llama-3_3-70B-Instruct',
  'Mistral-Nemo-Instruct-2407',
  'gpt-oss-20b',
  'Mistral-Small-3.2-24B-Instruct',
];

const HUGGINGFACE_SUGGESTIONS = [
  'openai/gpt-oss-120b:fastest',
  'Qwen/Qwen2.5-Coder-32B-Instruct',
  'meta-llama/Meta-Llama-3.1-8B-Instruct',
  'google/gemma-3-4b-it',
];

const DASHSCOPE_SUGGESTIONS = [
  'qwen-plus',
  'qwen-turbo',
  'qwen-max',
  'qwen3-coder-plus',
  'qwen-vl-plus',
];

const MISTRAL_SUGGESTIONS = [
  'mistral-small-latest',
  'mistral-large-latest',
  'codestral-latest',
  'pixtral-large-latest',
];

const XAI_SUGGESTIONS = ['grok-3-mini', 'grok-3', 'grok-2-latest'];

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const groups = [
    {
      provider: 'chatre',
      label: 'Chatre (default)',
      models: CHATRE_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        value: m.id,
      })),
    },
  ];

  if (auth.kind === 'user') {
    const byokDoc = await users.getByokDoc(auth.uid);
    const flags = users.byokConfiguredFlags(byokDoc);
    if (flags.openrouter) {
      groups.push({
        provider: 'openrouter',
        label: 'OpenRouter',
        models: OPENROUTER_SUGGESTIONS.map((id) => ({
          id,
          label: /:free$/i.test(id)
            ? id.replace(/:free$/i, '') + ' (free)'
            : id === 'openrouter/free'
              ? 'Auto free router'
              : id,
          value: 'openrouter:' + id,
          free: /:free$/i.test(id) || id === 'openrouter/free',
        })),
      });
    }
    if (flags.aihubmix) {
      groups.push({
        provider: 'aihubmix',
        label: 'AIHubMix',
        models: AIHUBMIX_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'aihubmix:' + id,
        })),
      });
    }
    if (flags.zai) {
      groups.push({
        provider: 'zai',
        label: 'Z.ai',
        models: ZAI_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'zai:' + id,
        })),
      });
    }
    if (flags.groq) {
      groups.push({
        provider: 'groq',
        label: 'Groq',
        models: GROQ_SUGGESTIONS.map((id) => ({
          id,
          label: id + ' (free tier)',
          value: 'groq:' + id,
          free: true,
        })),
      });
    }
    if (flags.deepseek) {
      groups.push({
        provider: 'deepseek',
        label: 'DeepSeek',
        models: DEEPSEEK_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'deepseek:' + id,
        })),
      });
    }
    if (flags.modelscope) {
      groups.push({
        provider: 'modelscope',
        label: 'ModelScope',
        models: MODELSCOPE_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'modelscope:' + id,
        })),
      });
    }
    if (flags.ollama) {
      groups.push({
        provider: 'ollama',
        label: 'Ollama Cloud',
        models: OLLAMA_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'ollama:' + id,
          free: true,
        })),
      });
    }
    if (flags.kilo) {
      groups.push({
        provider: 'kilo',
        label: 'Kilo Code',
        models: KILO_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'kilo:' + id,
          free: /:free$/i.test(id) || id === 'kilo-auto/free',
        })),
      });
    }
    if (flags.cloudflare) {
      groups.push({
        provider: 'cloudflare',
        label: 'Cloudflare Workers AI',
        models: CLOUDFLARE_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'cloudflare:' + id,
          free: true,
        })),
      });
    }
    if (flags.llm7) {
      groups.push({
        provider: 'llm7',
        label: 'LLM7.io',
        models: LLM7_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'llm7:' + id,
          free: true,
        })),
      });
    }
    if (flags.ovhcloud) {
      groups.push({
        provider: 'ovhcloud',
        label: 'OVHcloud AI Endpoints',
        models: OVHCLOUD_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'ovhcloud:' + id,
          free: true,
        })),
      });
    }
    if (flags.huggingface) {
      groups.push({
        provider: 'huggingface',
        label: 'Hugging Face',
        models: HUGGINGFACE_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'huggingface:' + id,
        })),
      });
    }
    if (flags.dashscope) {
      groups.push({
        provider: 'dashscope',
        label: 'Alibaba Model Studio',
        models: DASHSCOPE_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'dashscope:' + id,
        })),
      });
    }
    if (flags.mistral) {
      groups.push({
        provider: 'mistral',
        label: 'Mistral',
        models: MISTRAL_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'mistral:' + id,
        })),
      });
    }
    if (flags.xai) {
      groups.push({
        provider: 'xai',
        label: 'xAI (Grok)',
        models: XAI_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'xai:' + id,
        })),
      });
    }
    if (flags.anthropic) {
      groups.push({
        provider: 'anthropic',
        label: 'Anthropic',
        models: ANTHROPIC_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'anthropic:' + id,
        })),
      });
    }
    if (flags.openai) {
      groups.push({
        provider: 'openai',
        label: 'OpenAI',
        models: OPENAI_SUGGESTIONS.map((id) => ({
          id,
          label: id,
          value: 'openai:' + id,
        })),
      });
    }
    if (flags.google) {
      groups.push({
        provider: 'google',
        label: 'Google Gemini',
        models: GOOGLE_SUGGESTIONS.map((id) => ({
          id,
          label: GOOGLE_LABELS[id] || id,
          value: 'google:' + id,
        })),
      });
    }
    if (flags.cursor) {
      let cursorModels = CURSOR_SUGGESTIONS.map((id) => ({
        id,
        label: CURSOR_LABELS[id] || id,
        value: 'cursor:' + id,
      }));
      try {
        const { listCursorModels } = require('../lib/providers/cursor');
        const { decrypt, encryptionConfigured } = require('../lib/crypto-secrets');
        if (encryptionConfigured()) {
          const blob = byokDoc && byokDoc.cursor;
          if (blob) {
            const key = decrypt(blob);
            const live = await listCursorModels(key);
            if (live && live.length) {
              const seen = new Set();
              cursorModels = [];
              live.forEach((it) => {
                if (!it.id || seen.has(it.id)) return;
                seen.add(it.id);
                cursorModels.push({
                  id: it.id,
                  label: it.displayName || CURSOR_LABELS[it.id] || it.id,
                  value: 'cursor:' + it.id,
                });
              });
              // Keep known Composer IDs even if the live list is sparse.
              CURSOR_SUGGESTIONS.forEach((id) => {
                if (seen.has(id)) return;
                cursorModels.unshift({
                  id,
                  label: CURSOR_LABELS[id] || id,
                  value: 'cursor:' + id,
                });
              });
            }
          }
        }
      } catch {
        /* keep static suggestions */
      }
      groups.push({
        provider: 'cursor',
        label: 'Cursor (Cloud Agents)',
        models: cursorModels,
      });
    }
  }

  return sendJson(res, 200, { groups });
};
