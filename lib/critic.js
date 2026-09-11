'use strict';

/**
 * Critic pass — verify executor output against analyst success criteria.
 */

const CRITIC_PROMPT = `You are Chatre's critic. Decide if the executor finished the user's request.

Given the user request, the plan (success criteria / approach), and the executor's final answer (and any tool notes), output ONLY JSON:
{
  "pass": true|false,
  "score": 0-100,
  "gaps": ["what is missing or wrong"],
  "fix_brief": "If pass=false, short orders for the executor to fix. Empty if pass=true."
}

Be strict about success criteria. Do not invent requirements not in the plan or user request.
You are Chatre — never mention other products.`;

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* continue */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* continue */
    }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeCritique(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  return {
    pass: o.pass === true,
    score: Math.max(0, Math.min(100, Number(o.score) || 0)),
    gaps: Array.isArray(o.gaps) ? o.gaps.map(String) : [],
    fix_brief: String(o.fix_brief || o.fixBrief || '').trim(),
  };
}

function criticUserPrompt({ userMessage, briefing, answer, toolSummary }) {
  return (
    'User request:\n' +
    String(userMessage || '').trim() +
    '\n\nPlan goal: ' +
    String((briefing && briefing.goal) || '') +
    '\nTask type: ' +
    String((briefing && briefing.task_type) || '') +
    '\nSuccess criteria:\n' +
    ((briefing && briefing.success_criteria) || [])
      .map((c, i) => i + 1 + '. ' + c)
      .join('\n') +
    '\n\nExecutor answer:\n' +
    String(answer || '').slice(0, 8000) +
    '\n\nTool summary:\n' +
    String(toolSummary || '(none)').slice(0, 4000)
  );
}

module.exports = {
  CRITIC_PROMPT,
  extractJsonObject,
  normalizeCritique,
  criticUserPrompt,
};
