'use strict';

/**
 * Plain chat endpoint — routes Chatre Worker vs BYOK providers (OpenRouter, etc.).
 * Used when the UI selects an openrouter:/anthropic:/openai:/google: model.
 */

const { handleCors, applyCors } = require('../lib/cors');
const { readBody, sendJson, requireAuth } = require('../lib/http');
const { chatRouted, parseModel, chatWorkerStreaming } = require('../lib/llm');

const CHAT_SYSTEM_PROMPT = `You are Chatre, a helpful assistant.
Be direct and concise. Never mention other products or agents — you are Chatre.
Do not invent file downloads or tool results.`;

function stripSystem(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role !== 'system')
    .map((m) => {
      const out = {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || ''),
      };
      if (m.reasoning_details) out.reasoning_details = m.reasoning_details;
      if (m.reasoning) out.reasoning = m.reasoning;
      if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
      return out;
    });
}

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  applyCors(res);

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.kind !== 'user') {
    return sendJson(res, 403, {
      error:
        'Sign in required for chat with BYOK models. The admin service key cannot run user chats (RBAC).',
    });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const model = String(body.model || '').trim();
  const { provider } = parseModel(model);
  if (provider !== 'chatre' && !auth.uid) {
    return sendJson(res, 401, { error: 'BYOK requires a signed-in user' });
  }

  const messages = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...stripSystem(body.messages),
  ];
  const maxTokens = Math.min(
    Math.max(Number(body.max_tokens || body.maxTokens) || 2048, 64),
    8192,
  );
  const wantStream = body.stream !== false;

  try {
    if (!wantStream) {
      const data = await chatRouted({
        messages,
        model,
        maxTokens,
        userId: auth.uid,
        agent: false,
        mode: 'chat',
      });
      return sendJson(res, 200, {
        response: data.response || data.text || '',
        model,
        provider,
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendDelta = (delta) => {
      if (!delta) return;
      res.write('data: ' + JSON.stringify({ response: delta }) + '\n\n');
    };

    if (provider === 'chatre') {
      await chatWorkerStreaming({
        messages,
        model,
        maxTokens,
        agent: false,
        userId: auth.uid,
        onToken: sendDelta,
      });
    } else {
      const data = await chatRouted({
        messages,
        model,
        maxTokens,
        userId: auth.uid,
        agent: false,
        mode: 'chat',
      });
      const text = data.response || data.text || '';
      if (!String(text).trim()) {
        res.write(
          'data: ' +
            JSON.stringify({
              error:
                'Model returned an empty response. For OpenRouter Gemini / reasoning models, raise max tokens or retry — thinking can consume the output budget.',
            }) +
            '\n\n',
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const chunk = 48;
      for (let i = 0; i < text.length; i += chunk) {
        sendDelta(text.slice(i, i + chunk));
      }
      // Preserve reasoning metadata for clients that store chat history (Gemini via OR)
      if (data.reasoning_details || data.reasoning) {
        res.write(
          'data: ' +
            JSON.stringify({
              meta: {
                reasoning_details: data.reasoning_details || null,
                reasoning: data.reasoning || null,
              },
            }) +
            '\n\n',
        );
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(err);
    const msg = err && err.message ? err.message : String(err);
    if (res.headersSent) {
      res.write('data: ' + JSON.stringify({ error: msg }) + '\n\n');
      res.end();
      return;
    }
    const status = /No API key saved|BYOK_ENCRYPTION|sign/i.test(msg)
      ? 400
      : /rate|quota|429/i.test(msg)
        ? 429
        : 500;
    return sendJson(res, status, { error: msg });
  }
};
