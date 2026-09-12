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
  return /gemini-3/.test(id);
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
          'Gemini used all output tokens on thinking and returned no text. Increase max tokens or use thinkingLevel=minimal.',
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

async function googleChat({ apiKey, modelId, messages, maxTokens, thinkingLevel }) {
  let id = String(modelId || 'gemini-3.6-flash').trim();
  if (id.startsWith('models/')) id = id.slice('models/'.length);
  // Retired aliases → current flash default
  if (id === 'gemini-2.0-flash' || id === 'gemini-2.0-flash-001') {
    id = 'gemini-3.6-flash';
  }

  const contents = [];
  let systemInstruction = null;
  (messages || []).forEach((m) => {
    if (m.role === 'system') {
      systemInstruction = {
        parts: [{ text: String(m.content || '') }],
      };
      return;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    });
  });

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(id) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  // Thinking models spend output budget on thoughts first — keep a usable floor.
  const outTokens = Math.max(Number(maxTokens) || 3072, usesThinkingLevel(id) ? 256 : 64);

  const generationConfig = {
    maxOutputTokens: outTokens,
  };
  if (usesLegacySampling(id)) {
    generationConfig.temperature = 0.4;
  }
  // Default minimal thinking so chat/ping actually return visible text
  if (usesThinkingLevel(id)) {
    generationConfig.thinkingConfig = {
      thinkingLevel: String(thinkingLevel || 'minimal').toLowerCase(),
    };
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

module.exports = { googleChat, extractGoogleText };
