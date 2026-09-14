'use strict';

function usesLegacySampling(modelId) {
  const id = String(modelId || '').toLowerCase();
  // Gemini 3.5-flash-lite and 3.6+ deprecate temperature/topP/topK
  if (/gemini-3\.6/.test(id) || /gemini-3\.[789]/.test(id)) return false;
  if (/gemini-3\.5-flash-lite/.test(id)) return false;
  return true;
}

function usesThinkingLevel(modelId) {
  const id = String(modelId || '').toLowerCase();
  return /gemini-3/.test(id) || /gemini-2\.5/.test(id);
}

/**
 * Supported thinkingLevel values per model (Google docs).
 * Never assume `minimal` for all gemini-3* — 3.7/3.8/Pro reject it.
 */
function supportedThinkingLevels(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!usesThinkingLevel(id)) return null;
  if (/gemini-3\.8-flash|gemini-3\.7-flash/.test(id)) {
    return ['low', 'medium', 'high'];
  }
  if (/gemini-3\.1-pro/.test(id)) return ['low', 'medium', 'high'];
  if (/gemini-3-pro/.test(id)) return ['low', 'high'];
  if (/gemini-3\.1-flash-lite-image/.test(id)) return ['minimal', 'high'];
  if (/gemini-3\.6-flash|gemini-3\.5-flash|gemini-3-flash-preview/.test(id)) {
    return ['minimal', 'low', 'medium', 'high'];
  }
  if (/gemini-3\.5-flash-lite/.test(id)) {
    return ['minimal', 'low', 'medium', 'high'];
  }
  if (/gemini-2\.5/.test(id)) return ['low', 'medium', 'high'];
  // Unknown Gemini 3.x: safe floor is low (not minimal)
  if (/gemini-3/.test(id)) return ['low', 'medium', 'high'];
  return ['low', 'medium', 'high'];
}

function resolveThinkingLevel(modelId, requested) {
  const levels = supportedThinkingLevels(modelId);
  if (!levels || !levels.length) return null;
  const want = String(requested || '')
    .toLowerCase()
    .trim();
  if (want && levels.indexOf(want) >= 0) return want;
  // Lowest supported — keeps chat/ping responsive without unsupported levels
  return levels[0];
}

function isThinkingLevelError(err) {
  const msg = String((err && err.message) || err || '');
  return /thinking\s*level|THINKING_LEVEL|not supported for this model/i.test(
    msg,
  );
}

function extractGoogleText(data) {
  const feedback = data && data.promptFeedback;
  if (feedback && feedback.blockReason) {
    return {
      text: '',
      error:
        'Google blocked the prompt (' +
        feedback.blockReason +
        '). Try rephrasing.',
    };
  }

  const candidates = (data && data.candidates) || [];
  if (!candidates.length) {
    return {
      text: '',
      error:
        'Google returned no candidates (empty response). Try again or pick another Gemini model.',
    };
  }

  const cand = candidates[0] || {};
  const finish = String(cand.finishReason || '');
  const parts = (cand.content && cand.content.parts) || [];
  const answerParts = [];
  const thoughtParts = [];
  parts.forEach((p) => {
    const t = p && typeof p.text === 'string' ? p.text : '';
    if (!t) return;
    if (p.thought) thoughtParts.push(t);
    else answerParts.push(t);
  });
  let text = answerParts.join('');
  // Fallback: some responses only expose thought summaries when answer text is empty
  if (!text && thoughtParts.length) {
    text = thoughtParts.join('\n').trim();
  }

  if (!text) {
    if (finish === 'MAX_TOKENS') {
      return {
        text: '',
        error:
          'Gemini used all output tokens on thinking and returned no text. Increase max tokens or use a lower thinkingLevel.',
      };
    }
    if (finish === 'SAFETY' || finish === 'RECITATION' || finish === 'BLOCKLIST') {
      return {
        text: '',
        error: 'Google stopped generation (' + finish + ').',
      };
    }
    if (finish === 'TOO_MANY_TOOL_CALLS') {
      return {
        text: '',
        error: 'Gemini stopped with TOO_MANY_TOOL_CALLS and no final text.',
      };
    }
    return {
      text: '',
      error:
        'Gemini returned an empty message' +
        (finish ? ' (finishReason=' + finish + ')' : '') +
        '.',
    };
  }

  return { text, error: null, finishReason: finish || null };
}

async function googleChatOnce({
  apiKey,
  modelId,
  messages,
  maxTokens,
  thinkingLevel,
  omitThinking,
}) {
  let id = String(modelId || 'gemini-3.8-flash').trim();
  if (id.startsWith('models/')) id = id.slice('models/'.length);
  // Retired / shut-down aliases → current flash default
  if (
    id === 'gemini-2.0-flash' ||
    id === 'gemini-2.0-flash-001' ||
    id === 'gemini-2.0-flash-lite' ||
    id === 'gemini-2.0-flash-lite-001'
  ) {
    id = 'gemini-3.8-flash';
  }

  const contents = [];
  let systemInstruction = null;
  (messages || []).forEach((m) => {
    if (!m) return;
    if (m.role === 'system') {
      systemInstruction = {
        parts: [{ text: String(m.content || '') }],
      };
      return;
    }
    let text =
      typeof m.content === 'string'
        ? m.content
        : m.content == null
          ? ''
          : JSON.stringify(m.content);
    if (m.role === 'tool') {
      text =
        'Tool result' +
        (m.name ? ' (' + m.name + ')' : '') +
        ':\n' +
        text;
    } else if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      text =
        (text ? text + '\n' : '') +
        JSON.stringify({ tool_calls: m.tool_calls });
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text }],
    });
  });

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(id) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  // Thinking models spend output budget on thoughts first — keep a usable floor.
  const outTokens = Math.max(
    Number(maxTokens) || 3072,
    usesThinkingLevel(id) ? 256 : 64,
  );

  const generationConfig = {
    maxOutputTokens: outTokens,
  };
  if (usesLegacySampling(id)) {
    generationConfig.temperature = 0.4;
  }
  if (usesThinkingLevel(id) && !omitThinking) {
    const level = resolveThinkingLevel(id, thinkingLevel);
    if (level) {
      generationConfig.thinkingConfig = {
        thinkingLevel: level,
      };
    }
  }

  const body = {
    contents,
    generationConfig,
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data && data.error && data.error.message) ||
        'Google AI error ' + res.status,
    );
  }

  const extracted = extractGoogleText(data);
  if (extracted.error && !extracted.text) {
    throw new Error(extracted.error);
  }
  return {
    response: extracted.text,
    raw: data,
    tool_calls: [],
    finishReason: extracted.finishReason || null,
  };
}

async function googleChat(opts) {
  const id = String(opts.modelId || '');
  const levels = supportedThinkingLevels(id) || [];
  let level = resolveThinkingLevel(id, opts.thinkingLevel);
  const tried = new Set();

  for (let attempt = 0; attempt < Math.max(2, levels.length + 1); attempt++) {
    try {
      return await googleChatOnce({
        ...opts,
        thinkingLevel: level,
        omitThinking: attempt > 0 && !level,
      });
    } catch (err) {
      if (!isThinkingLevelError(err)) throw err;
      if (level) tried.add(level);
      const next = levels.find((l) => !tried.has(l));
      if (next) {
        level = next;
        continue;
      }
      // Last resort: omit thinkingConfig entirely
      if (attempt === 0 || level) {
        level = null;
        continue;
      }
      throw err;
    }
  }
  return googleChatOnce({ ...opts, thinkingLevel: null, omitThinking: true });
}

module.exports = {
  googleChat,
  extractGoogleText,
  resolveThinkingLevel,
  supportedThinkingLevels,
};
