'use strict';

/**
 * Lightweight agent utilities — compaction, title, summary, custom generate.
 */

const { chatWorker } = require('./llm');
const {
  PROMPT_GENERATE,
  PROMPT_COMPACTION,
  PROMPT_TITLE,
  PROMPT_SUMMARY,
  listNative,
  normalizeCustomAgent,
} = require('./agents');

function extractJsonObject(text) {
  const raw = String(text || '').trim();
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

async function runHiddenPrompt({
  system,
  user,
  model,
  userId,
  maxTokens,
}) {
  const data = await chatWorker({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    model,
    userId,
    maxTokens: maxTokens || 600,
    stream: false,
    agent: false,
  });
  return typeof data === 'string'
    ? data
    : (data && (data.response || data.text)) || '';
}

async function generateThreadTitle({ userMessage, model, userId }) {
  try {
    const text = await runHiddenPrompt({
      system: PROMPT_TITLE,
      user: String(userMessage || '').slice(0, 800),
      model,
      userId,
      maxTokens: 40,
    });
    return String(text || '')
      .replace(/^["'#\s]+|["'\s.]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 80);
  } catch {
    return String(userMessage || 'Chat').slice(0, 60);
  }
}

async function compactMessages({ messages, model, userId, goal, runState }) {
  const SelfAwareness = require('./self-awareness');
  const transcript = (messages || [])
    .slice(0, -6)
    .map((m) => {
      const role = (m && m.role) || 'user';
      let content = '';
      if (typeof (m && m.content) === 'string') content = m.content;
      else if (m && m.content != null) content = JSON.stringify(m.content);
      if (m && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        content +=
          (content ? '\n' : '') +
          JSON.stringify({ tool_calls: m.tool_calls }).slice(0, 400);
      }
      return role.toUpperCase() + ':\n' + String(content).slice(0, 1200);
    })
    .join('\n\n')
    .slice(0, 12000);

  const user = SelfAwareness.workStateCompactionUser(goal, transcript, runState);

  try {
    const summary = await runHiddenPrompt({
      system: PROMPT_COMPACTION,
      user,
      model,
      userId,
      maxTokens: 900,
    });
    const kept = (messages || []).slice(-6);
    const statusTail =
      runState && (runState.doneWhen || runState.phase)
        ? '\n\nPreserved run facts:\n- phase: ' +
          String(runState.phase || '') +
          '\n- done_when: ' +
          String(runState.doneWhen || '').slice(0, 300) +
          '\n- deliverySuccess: ' +
          !!runState.deliverySuccess +
          '\n- files: ' +
          ((runState.filesTouched || []).slice(-12).join(', ') || '(none)')
        : '';
    return [
      {
        role: 'user',
        content:
          '[compacted context — Work State]\n' +
          String(summary || '').trim() +
          statusTail +
          '\n[/compacted context]',
      },
      ...kept,
    ];
  } catch {
    return messages;
  }
}

async function summarizeRun({ answer, filesTouched, model, userId }) {
  try {
    const text = await runHiddenPrompt({
      system: PROMPT_SUMMARY,
      user:
        'Files: ' +
        (filesTouched || []).slice(-20).join(', ') +
        '\n\nAnswer draft:\n' +
        String(answer || '').slice(0, 4000),
      model,
      userId,
      maxTokens: 400,
    });
    return String(text || '').trim();
  } catch {
    return '';
  }
}

async function generateCustomAgent({
  description,
  model,
  userId,
  existingNames,
  workspaceHint,
}) {
  const existing = (existingNames || [])
    .concat(listNative({ includeHidden: true }).map((a) => a.name))
    .filter(Boolean);
  const user =
    'Create an agent configuration based on this request: "' +
    String(description || '').slice(0, 800) +
    '".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ' +
    existing.join(', ') +
    '\n' +
    (workspaceHint
      ? '\nWorkspace context:\n' + String(workspaceHint).slice(0, 1500)
      : '') +
    '\nReturn ONLY the JSON object.';

  const raw = await runHiddenPrompt({
    system: PROMPT_GENERATE,
    user,
    model,
    userId,
    maxTokens: 1200,
  });
  const obj = extractJsonObject(raw);
  if (!obj) {
    throw new Error('Agent generator returned invalid JSON');
  }
  const agent = normalizeCustomAgent(obj);
  if (!agent) throw new Error('Could not normalize generated agent');
  if (existing.indexOf(agent.name) >= 0) {
    agent.name = agent.name + '-' + Math.random().toString(36).slice(2, 5);
    agent.identifier = agent.name;
  }
  return agent;
}

function shouldCompact(messages, softLimit) {
  const limit = softLimit || 3200;
  let total = 0;
  for (let i = 0; i < (messages || []).length; i++) {
    total += Math.ceil(String((messages[i] && messages[i].content) || '').length / 4);
  }
  return total > limit * 0.85 && (messages || []).length > 10;
}

module.exports = {
  generateThreadTitle,
  compactMessages,
  summarizeRun,
  generateCustomAgent,
  shouldCompact,
  extractJsonObject,
};
