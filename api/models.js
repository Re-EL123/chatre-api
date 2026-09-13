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

const OPENROUTER_SUGGESTIONS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3.5-sonnet',
  'google/gemini-3.6-flash',
  'meta-llama/llama-3.3-70b-instruct',
];

const ANTHROPIC_SUGGESTIONS = [
  'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
];

const OPENAI_SUGGESTIONS = ['gpt-4o-mini', 'gpt-4o', 'o4-mini'];

const GOOGLE_SUGGESTIONS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
];

const AIHUBMIX_SUGGESTIONS = [
  'gpt-4o-mini',
  'gpt-4o',
  'claude-3-5-sonnet-latest',
  'claude-sonnet-4-20250514',
  'gemini-2.5-flash',
  'deepseek-v3',
];

const ZAI_SUGGESTIONS = [
  'glm-5.3-flash',
  'glm-5.3',
  'glm-4.7',
  'glm-4.6',
  'glm-4.5-flash',
];

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
          label: id,
          value: 'openrouter:' + id,
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
          label: id,
          value: 'google:' + id,
        })),
      });
    }
  }

  return sendJson(res, 200, { groups });
};
