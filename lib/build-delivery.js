'use strict';

/**
 * Build delivery helpers — prevent chat-only "I wrote the files" theatre.
 */

function shouldBuildFastPath(briefing, userMessage) {
  const t = String((briefing && briefing.task_type) || '').toLowerCase();
  if (t !== 'build' && t !== 'mixed' && t !== 'debug') return false;
  const msg = String(userMessage || '').toLowerCase();
  return (
    /\b(html|css|javascript|\.js\b|canvas|bubble.?shooter|game in html|website|web app|landing page|single.?page|frontend)\b/.test(
      msg,
    ) ||
    /\b(create|make|build|design|scaffold)\b.{0,80}\b(game|app|page|site|project)\b/.test(
      msg,
    )
  );
}

function projectSlug(userMessage, goal) {
  const raw = String(goal || userMessage || 'project')
    .toLowerCase()
    .replace(/\b(design|create|make|build|me|a|an|the|in|with|using|html|css|js|javascript)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return raw || 'project';
}

/**
 * Pull fenced or labeled file bodies out of model narration.
 * Returns [{ relativePath, content }].
 */
function extractFilesFromNarration(text) {
  const src = String(text || '');
  const out = [];
  const seen = new Set();

  function add(rel, content) {
    const path = String(rel || '')
      .replace(/^\/+/, '')
      .replace(/^home\/user\/projects\/[^/]+\//, '')
      .trim();
    const body = String(content || '').trim();
    if (!path || !body || body.length < 8) return;
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ relativePath: path, content: body });
  }

  // ```html / ```css / ```js (optional path on same line)
  const fenceRe = /```(\w+)?([^\n]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(src))) {
    const lang = String(m[1] || '').toLowerCase();
    const meta = String(m[2] || '').trim();
    const body = m[3];
    let rel = '';
    const pathEq = meta.match(/(?:path|file)\s*[=:]\s*([^\s]+)/i);
    if (pathEq) rel = pathEq[1];
    else if (/\.(html?|css|js|json|md|txt)$/i.test(meta)) {
      rel = meta.split(/\s+/).pop();
    } else if (lang === 'html' || /<!DOCTYPE|<html[\s>]/i.test(body)) {
      rel = 'index.html';
    } else if (lang === 'css') {
      rel = 'style.css';
    } else if (lang === 'js' || lang === 'javascript') {
      rel = 'script.js';
    } else if (lang === 'json') {
      rel = 'data.json';
    }
    if (rel) add(rel.replace(/^["']|["']$/g, ''), body);
  }

  // Labeled blocks: "### index.html" or "1. Create index.html" followed by fence
  const labeled =
    /(?:^|\n)(?:#{1,3}\s*|[-*]\s*|\d+\.\s*)?(?:create\s+|write\s+)?([a-z0-9._/-]+\.(?:html?|css|js|json|md))\b[\s\S]{0,120}?```(?:\w+)?\s*\n([\s\S]*?)```/gi;
  while ((m = labeled.exec(src))) {
    add(m[1], m[2]);
  }

  // Absolute path claims with following fence
  const abs =
    /\/home\/user\/projects\/[^/\s]+\/([a-z0-9._/-]+\.(?:html?|css|js))\b[\s\S]{0,200}?```(?:\w+)?\s*\n([\s\S]*?)```/gi;
  while ((m = abs.exec(src))) {
    add(m[1], m[2]);
  }

  return out;
}

function looksLikeFakeDeliveryClaim(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  const claimsWrite =
    /\b(writing|created|creating|wrote|saved|successfully)\b[\s\S]{0,80}\b(file|files|index\.html|style\.css|script\.js|project)\b/i.test(
      t,
    ) ||
    /\/home\/user\/projects\/[^\s]+/i.test(t);
  const hasCodeDump =
    /```/.test(t) || /<!DOCTYPE html|<canvas|const canvas/i.test(t);
  return claimsWrite || (hasCodeDump && /bubble|game|index\.html/i.test(t));
}

/**
 * Build prompt for structured multi-file generation.
 */
function buildFilesPrompt(userMessage, goal, slug) {
  return (
    'Generate a complete playable mini project as JSON only (no markdown fences, no prose).\n' +
    'Shape: {"slug":"' +
    slug +
    '","files":[{"path":"index.html","content":"..."},{"path":"style.css","content":"..."},{"path":"script.js","content":"..."}]}\n' +
    'Rules:\n' +
    '- Every file needs FULL content (not placeholders).\n' +
    '- Prefer index.html + style.css + script.js for web games/apps.\n' +
    '- Make it actually work in a browser (canvas or DOM).\n' +
    '- Good visual design: dark background, clear contrast, intentional typography — not a bare white page.\n' +
    '- No tool blocks. JSON only.\n\n' +
    'User request:\n' +
    String(userMessage || '') +
    '\n\nGoal: ' +
    String(goal || '')
  );
}

function parseGeneratedFiles(text) {
  const raw = String(text || '').trim();
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
      try {
        obj = JSON.parse(fence[1].trim());
      } catch {
        /* ignore */
      }
    }
    if (!obj) {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          obj = JSON.parse(raw.slice(start, end + 1));
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const slug =
    String(obj.slug || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || null;
  const files = Array.isArray(obj.files) ? obj.files : [];
  const out = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const path = String(f.path || f.name || '')
      .replace(/^\/+/, '')
      .trim();
    const content = String(f.content || f.body || '');
    if (!path || !content) continue;
    out.push({ relativePath: path, content });
  }
  if (!out.length) return null;
  return { slug, files: out };
}

module.exports = {
  shouldBuildFastPath,
  projectSlug,
  extractFilesFromNarration,
  looksLikeFakeDeliveryClaim,
  buildFilesPrompt,
  parseGeneratedFiles,
};
