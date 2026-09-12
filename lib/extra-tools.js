'use strict';

/**
 * Hermes-inspired extra tools adapted for Chatre.
 */

const { fetchUrl } = require('./fetch-readable');
const { SKILL_GUIDES, expandSkillGuide } = require('./skills');
const { getPlaybook } = require('./skill-playbooks');
const { listThreads, getThread, listMessages } = require('./threads');
const users = require('./users');
const { decrypt, encryptionConfigured } = require('./crypto-secrets');
const { putFile, saveSnapshot } = require('./workspace');
const { ensureParentDirs } = require('./paths');

function clarifyTool(params) {
  const p = params || {};
  // Single-question form (compatible with ask_user_input UI)
  if (p.question && (p.options || p.choices)) {
    const opts = normalizeChoices(p.options || p.choices);
    const recommended = p.recommended != null ? Number(p.recommended) : -1;
    const options = opts.map((o, i) => ({
      label: i === recommended ? o.label + ' (Recommended)' : o.label,
      value: o.value,
    }));
    if (options.length < 2) {
      return {
        ok: false,
        tool: 'clarify',
        error: 'clarify needs 2-4 choices (or use open-ended with allow_free_text)',
      };
    }
    return {
      ok: true,
      tool: 'clarify',
      type: 'user_input',
      question: String(p.question).trim(),
      options: options.slice(0, 4),
      allow_free_text: p.allow_free_text !== false,
      text: String(p.question).trim(),
      await_clarify: true,
    };
  }
  // Multi-question batch
  const questions = Array.isArray(p.questions) ? p.questions : [];
  if (!questions.length) {
    return {
      ok: false,
      tool: 'clarify',
      error: 'Provide question+options or questions[]',
    };
  }
  const q0 = questions[0] || {};
  const opts = normalizeChoices(q0.options || q0.choices);
  if (opts.length < 2) {
    return { ok: false, tool: 'clarify', error: 'Each question needs 2-4 choices' };
  }
  return {
    ok: true,
    tool: 'clarify',
    type: 'user_input',
    question: String(q0.question || q0.prompt || '').trim(),
    options: opts.slice(0, 4),
    questions: questions.slice(0, 5).map((q) => ({
      question: String(q.question || q.prompt || '').trim(),
      options: normalizeChoices(q.options || q.choices).slice(0, 4),
    })),
    text: String(q0.question || '').trim(),
    await_clarify: true,
  };
}

function normalizeChoices(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (const c of arr) {
    if (out.length >= 4) break;
    if (typeof c === 'string' && c.trim()) {
      out.push({ label: c.trim(), value: c.trim() });
    } else if (c && typeof c === 'object') {
      const label = c.label || c.text || c.title || c.value || c.name;
      if (label) out.push({ label: String(label), value: String(c.value || label) });
    }
  }
  return out;
}

async function executeCodeTool(params, ctx, runners) {
  const p = params || {};
  const lang = String(p.language || p.lang || 'javascript').toLowerCase();
  const code = String(p.code || p.source || '');
  if (!code.trim()) return { ok: false, tool: 'execute_code', error: 'code required' };
  if (lang === 'javascript' || lang === 'js' || lang === 'node') {
    return runners.runJavascript(code, ctx);
  }
  if (lang === 'python' || lang === 'py') {
    return runners.runPython(code, ctx);
  }
  if (lang === 'shell' || lang === 'bash' || lang === 'sh') {
    return runners.runShell(code, ctx);
  }
  return {
    ok: false,
    tool: 'execute_code',
    error: 'Unsupported language. Use javascript, python, or shell.',
  };
}

async function webExtractTool(params) {
  const res = await fetchUrl(
    Object.assign({}, params, {
      max_chars: Math.min(Number(params && params.max_chars) || 32000, 80000),
    }),
  );
  return Object.assign({ tool: 'web_extract' }, res, {
    text: res.text || res.content || res.error || '',
  });
}

async function sessionSearchTool(params, ctx) {
  const q = String((params && (params.query || params.q)) || '')
    .toLowerCase()
    .trim();
  if (!q) return { ok: false, tool: 'session_search', error: 'query required' };
  const userId = ctx && ctx.userId;
  const threads = await listThreads(40, { userId });
  const hits = [];
  for (const thr of threads.slice(0, 20)) {
    let msgs = [];
    try {
      msgs = await listMessages(thr.id, 80);
    } catch {
      continue;
    }
    for (const m of msgs || []) {
      const content = String(m.content || '');
      if (content.toLowerCase().indexOf(q) >= 0) {
        hits.push({
          thread_id: thr.id,
          title: thr.title || '',
          role: m.role,
          snippet: content.slice(0, 280),
          at: m.createdAt || thr.updatedAt || '',
        });
        if (hits.length >= 20) break;
      }
    }
    if (hits.length >= 20) break;
  }
  return {
    ok: true,
    tool: 'session_search',
    query: q,
    hits,
    text: hits.length
      ? hits.map((h) => '[' + h.thread_id + '] ' + h.snippet).join('\n')
      : 'No matches in recent threads',
  };
}

function skillViewTool(params) {
  const name = String((params && params.name) || '').toLowerCase().trim();
  if (!name) {
    return {
      ok: true,
      tool: 'skill_view',
      skills: Object.keys(SKILL_GUIDES),
      text: Object.keys(SKILL_GUIDES).join(', '),
    };
  }
  const expanded = expandSkillGuide(name, params || {});
  if (!expanded) {
    return {
      ok: false,
      tool: 'skill_view',
      error: 'Unknown skill',
      available: Object.keys(SKILL_GUIDES),
    };
  }
  const playbook = getPlaybook(name);
  return {
    ok: true,
    tool: 'skill_view',
    name,
    guide: expanded.guide,
    text: expanded.text,
    playbook: playbook || null,
  };
}

function skillManageTool(params, ctx) {
  const action = String((params && params.action) || 'list').toLowerCase();
  if (action === 'list') {
    return {
      ok: true,
      tool: 'skill_manage',
      skills: Object.keys(SKILL_GUIDES).map((n) => ({
        name: n,
        summary: SKILL_GUIDES[n],
      })),
      text: Object.keys(SKILL_GUIDES).join(', '),
    };
  }
  if (action === 'view') return skillViewTool(params);
  if (action === 'pin' || action === 'unpin') {
    const name = String((params && params.name) || '').toLowerCase();
    if (!name || !SKILL_GUIDES[name]) {
      return { ok: false, tool: 'skill_manage', error: 'Unknown skill name' };
    }
    // Preference only — stored on ctx for this run; durable via memory_set if caller wants
    ctx.skillPrefs = ctx.skillPrefs || {};
    ctx.skillPrefs[name] = action === 'pin';
    return {
      ok: true,
      tool: 'skill_manage',
      action,
      name,
      text: action + 'ned ' + name + '. Use memory_set to persist across runs.',
    };
  }
  return {
    ok: false,
    tool: 'skill_manage',
    error: 'action must be list|view|pin|unpin',
  };
}

async function getByokKey(userId, provider) {
  if (!userId || !encryptionConfigured()) return null;
  try {
    const doc = await users.getByokDoc(userId);
    const enc = doc && doc[provider];
    if (!enc) return null;
    return decrypt(enc);
  } catch {
    return null;
  }
}

async function visionAnalyzeTool(params, ctx) {
  const p = params || {};
  const question = String(p.question || p.prompt || 'Describe this image.').slice(0, 2000);
  let b64 = p.image_base64 || p.image || '';
  let mime = p.mime || 'image/jpeg';
  if (!b64 && ctx && ctx.lastScreenshotBase64) {
    b64 = ctx.lastScreenshotBase64;
    mime = ctx.lastScreenshotMime || mime;
  }
  if (!b64) {
    return {
      ok: false,
      tool: 'vision_analyze',
      error: 'image_base64 required (or take a browser/desktop screenshot first)',
    };
  }
  if (String(b64).startsWith('data:')) {
    const m = String(b64).match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      mime = m[1];
      b64 = m[2];
    }
  }

  const openrouterKey = await getByokKey(ctx && ctx.userId, 'openrouter');
  const openaiKey = await getByokKey(ctx && ctx.userId, 'openai');
  const key = openrouterKey || openaiKey;
  const url = openrouterKey
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const model = openrouterKey
    ? String(p.model || 'openai/gpt-4o-mini')
    : String(p.model || 'gpt-4o-mini');

  if (!key) {
    return {
      ok: false,
      tool: 'vision_analyze',
      error:
        'Vision needs a BYOK OpenRouter or OpenAI key with a vision-capable model. Save one in Settings → BYOK.',
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(openrouterKey ? { 'HTTP-Referer': 'https://chatre', 'X-Title': 'Chatre' } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(Number(p.max_tokens) || 800, 2000),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            {
              type: 'image_url',
              image_url: { url: 'data:' + mime + ';base64,' + b64 },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return {
      ok: false,
      tool: 'vision_analyze',
      error: 'Vision API failed (' + res.status + '): ' + String(err).slice(0, 300),
    };
  }
  const data = await res.json();
  const text =
    (data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content) ||
    '';
  return {
    ok: true,
    tool: 'vision_analyze',
    analysis: text,
    text: text,
    model,
  };
}

async function imageGenerateTool(params, ctx) {
  const p = params || {};
  const prompt = String(p.prompt || p.description || '').trim();
  if (!prompt) return { ok: false, tool: 'image_generate', error: 'prompt required' };

  const falKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  const openrouterKey = await getByokKey(ctx && ctx.userId, 'openrouter');
  const openaiKey = await getByokKey(ctx && ctx.userId, 'openai');

  let imageB64 = null;
  let mime = 'image/png';
  let source = '';

  if (falKey) {
    const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: {
        Authorization: 'Key ' + falKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        image_size: p.size || 'square_hd',
        num_images: 1,
      }),
    });
    if (falRes.ok) {
      const data = await falRes.json();
      const url =
        data &&
        data.images &&
        data.images[0] &&
        (data.images[0].url || data.images[0]);
      if (url) {
        const img = await fetch(url);
        const buf = Buffer.from(await img.arrayBuffer());
        imageB64 = buf.toString('base64');
        source = 'fal';
      }
    }
  }

  if (!imageB64 && (openrouterKey || openaiKey)) {
    const key = openrouterKey || openaiKey;
    const url = openrouterKey
      ? 'https://openrouter.ai/api/v1/images/generations'
      : 'https://api.openai.com/v1/images/generations';
    const model = openrouterKey
      ? String(p.model || 'openai/gpt-image-1')
      : String(p.model || 'dall-e-3');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: p.size || '1024x1024',
        response_format: 'b64_json',
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const b64 =
        data && data.data && data.data[0] && (data.data[0].b64_json || data.data[0].b64);
      if (b64) {
        imageB64 = b64;
        source = openrouterKey ? 'openrouter' : 'openai';
      }
    } else if (!falKey) {
      const err = await res.text().catch(() => '');
      return {
        ok: false,
        tool: 'image_generate',
        error:
          'Image generation failed. Set FAL_KEY on the server or use an OpenAI/OpenRouter image-capable BYOK key. ' +
          String(err).slice(0, 200),
      };
    }
  }

  if (!imageB64) {
    return {
      ok: false,
      tool: 'image_generate',
      error:
        'No image provider configured. Set FAL_KEY env, or save OpenAI/OpenRouter BYOK with image models.',
    };
  }

  const safe =
    String(p.filename || 'generated')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'generated';
  const filePath =
    String(p.path || '').trim() ||
    '/home/user/documents/' + safe.replace(/\.png$/i, '') + '.png';
  ensureParentDirs(ctx.files, filePath);
  ctx.files[filePath] = {
    path: filePath,
    type: 'file',
    content: imageB64,
    encoding: 'base64',
    mime,
  };
  if (ctx.workspaceId) {
    await putFile(ctx.workspaceId, {
      path: filePath,
      type: 'file',
      content: imageB64,
      encoding: 'base64',
      mime,
    });
    await saveSnapshot(ctx.workspaceId, {
      files: ctx.files,
      cwd: ctx.cwd,
      git: ctx.git,
    });
  }
  if (ctx.filesTouched) ctx.filesTouched.push(filePath);
  return {
    ok: true,
    tool: 'image_generate',
    path: filePath,
    source,
    prompt,
    text: 'Generated image saved to ' + filePath + ' (open Files panel)',
    artifact: true,
  };
}

async function textToSpeechTool(params, ctx) {
  const p = params || {};
  const text = String(p.text || p.input || '').trim();
  if (!text) return { ok: false, tool: 'text_to_speech', error: 'text required' };
  const openaiKey = await getByokKey(ctx && ctx.userId, 'openai');
  const openrouterKey = await getByokKey(ctx && ctx.userId, 'openrouter');
  // Prefer OpenAI audio API
  if (!openaiKey && !openrouterKey) {
    return {
      ok: false,
      tool: 'text_to_speech',
      error: 'TTS needs an OpenAI BYOK key (audio/speech). Save one in Settings → BYOK.',
    };
  }
  const key = openaiKey || openrouterKey;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: String(p.model || 'gpt-4o-mini-tts'),
      voice: String(p.voice || 'alloy'),
      input: text.slice(0, 4000),
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return {
      ok: false,
      tool: 'text_to_speech',
      error: 'TTS failed (' + res.status + '): ' + String(err).slice(0, 240),
    };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const b64 = buf.toString('base64');
  const filePath =
    String(p.path || '').trim() ||
    '/home/user/documents/tts-' + Date.now().toString(36) + '.mp3';
  ensureParentDirs(ctx.files, filePath);
  ctx.files[filePath] = {
    path: filePath,
    type: 'file',
    content: b64,
    encoding: 'base64',
    mime: 'audio/mpeg',
  };
  if (ctx.workspaceId) {
    await putFile(ctx.workspaceId, {
      path: filePath,
      type: 'file',
      content: b64,
      encoding: 'base64',
      mime: 'audio/mpeg',
    });
    await saveSnapshot(ctx.workspaceId, {
      files: ctx.files,
      cwd: ctx.cwd,
      git: ctx.git,
    });
  }
  if (ctx.filesTouched) ctx.filesTouched.push(filePath);
  return {
    ok: true,
    tool: 'text_to_speech',
    path: filePath,
    bytes: buf.length,
    text: 'Audio saved to ' + filePath,
    artifact: true,
  };
}

async function videoAnalyzeTool(params, ctx) {
  // Lightweight: treat as vision on a provided frame, or refuse without frames
  if (params && (params.image_base64 || params.frame_base64)) {
    return visionAnalyzeTool(
      Object.assign({}, params, {
        image_base64: params.image_base64 || params.frame_base64,
        question:
          params.question ||
          'Describe this video frame and any visible action or UI state.',
      }),
      ctx,
    );
  }
  return {
    ok: false,
    tool: 'video_analyze',
    error:
      'Pass frame_base64 / image_base64 of a keyframe for now (full video upload not yet supported).',
  };
}

/**
 * Lightweight delegate: one nested LLM+tools pass with a reduced tool set.
 * runners.delegateRun({ goal, context, model, userId, ctx }) must be provided by agent.js
 */
async function delegateTaskTool(params, ctx, runners) {
  const p = params || {};
  const hasGoals = Array.isArray(p.goals) && p.goals.length;
  const goal = String(p.goal || p.task || '').trim();
  if (!goal && !hasGoals) {
    return { ok: false, tool: 'delegate_task', error: 'goal or goals[] required' };
  }
  if (!runners || !runners.delegateRun) {
    return { ok: false, tool: 'delegate_task', error: 'Delegation not available in this runtime' };
  }
  const result = await runners.delegateRun({
    goal: goal || (hasGoals ? String(p.goals[0].goal || '') : ''),
    context: String(p.context || '').slice(0, 4000),
    toolsets: p.toolsets,
    model: p.model || (ctx && ctx.model),
    userId: ctx && ctx.userId,
    ctx,
    maxSteps: Math.min(Number(p.max_steps) || 5, 8),
  });
  return Object.assign({ tool: 'delegate_task', ok: !(result && result.ok === false) }, result);
}

module.exports = {
  clarifyTool,
  executeCodeTool,
  webExtractTool,
  sessionSearchTool,
  skillViewTool,
  skillManageTool,
  visionAnalyzeTool,
  imageGenerateTool,
  textToSpeechTool,
  videoAnalyzeTool,
  delegateTaskTool,
};
