'use strict';

/**
 * Build delivery helpers — prevent chat-only "I wrote the files" theatre.
 */

function shouldBuildFastPath(briefing, userMessage) {
  const t = String((briefing && briefing.task_type) || '').toLowerCase();
  if (t !== 'build' && t !== 'mixed' && t !== 'debug') return false;
  const msg = String(userMessage || '').toLowerCase();
  // Explicit web stack / UI asks (including calculator etc. without saying "html")
  if (
    /\b(html|css|javascript|\.js\b|canvas|bubble.?shooter|game in html|website|web app|landing page|single.?page|frontend|vanilla)\b/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /\b(create|make|build|design|scaffold|write)\b.{0,100}\b(game|app|page|site|project|calculator|widget|todo|todos|counter|clock|quiz|form|dashboard|ui)\b/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /\b(calculator|todo\s*app|to-?do list|counter app|stopwatch|timer app|quiz app)\b/.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

function projectSlug(userMessage, goal) {
  const blob = String(userMessage || '') + ' ' + String(goal || '');
  if (isRacingRequest(userMessage, goal)) {
    return wantsTwoPlayer(userMessage, goal) ? 'twin-lane-rally' : 'racing-game';
  }
  if (isShooterRequest(userMessage, goal)) return 'ops-game';
  if (/\bcalculator\b/i.test(blob)) return 'calculator';
  const raw = String(goal || userMessage || 'project')
    .toLowerCase()
    // Drop instruction filler so slugs stay short product names.
    .replace(
      /\b(design|create|make|build|me|a|an|the|in|with|using|html|css|js|javascript|please|just|simple|basic|doese|does|seem|like|add|libraries|frameworks|help|it|to|for|my|your|that|this|not)\b/g,
      ' ',
    )
    .replace(/\/home\/user\/projects\/[^\s`'"\])|,]+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.+$/g, '')
    .slice(0, 40);
  if (raw && raw.length >= 2) return raw;
  if (/\bgame\b/i.test(blob)) return 'game';
  return 'project';
}

/**
 * Prefer an explicit /home/user/projects/<slug>/… path over free-text slugify.
 */
function extractExplicitProjectPath(text) {
  const src = String(text || '');
  const m = src.match(
    /\/home\/user\/projects\/([A-Za-z0-9._-]+)(?:\/([^\s`'"\)\],]+))?/,
  );
  if (!m) return null;
  const slug = m[1];
  let relativePath = m[2] ? String(m[2]).replace(/\/+$/, '') : null;
  if (relativePath && /\/$/.test(String(m[2] || ''))) relativePath = null;
  if (relativePath && !/\.[A-Za-z0-9]+$/.test(relativePath) && !relativePath.includes('.')) {
    // directory-only mention
    relativePath = null;
  }
  return {
    slug,
    relativePath,
    absoluteFile: relativePath
      ? '/home/user/projects/' + slug + '/' + relativePath
      : null,
    root: '/home/user/projects/' + slug,
  };
}

function resolveProjectTarget(userMessage, goal, briefing) {
  const blob =
    String(userMessage || '') +
    ' ' +
    String(goal || '') +
    ' ' +
    ((briefing && Array.isArray(briefing.files) && briefing.files.join(' ')) ||
      '');
  let fromMsg =
    extractExplicitProjectPath(userMessage) ||
    extractExplicitProjectPath(goal);
  if (!fromMsg) {
    const files = briefing && Array.isArray(briefing.files) ? briefing.files : [];
    for (let i = 0; i < files.length; i++) {
      const hit = extractExplicitProjectPath(files[i]);
      if (hit) {
        fromMsg = Object.assign({ source: 'briefing' }, hit);
        break;
      }
    }
  } else {
    fromMsg = Object.assign({ source: 'message' }, fromMsg);
  }

  // "as index.html in /home/user/projects/calculator/"
  if (fromMsg && !fromMsg.relativePath) {
    const asFile = blob.match(
      /\bas\s+([A-Za-z0-9._/-]+\.(?:html?|css|js))\b/i,
    );
    if (asFile) {
      fromMsg.relativePath = asFile[1].replace(/^\/+/, '');
      fromMsg.absoluteFile =
        fromMsg.root + '/' + fromMsg.relativePath;
    } else if (/\bindex\.html\b/i.test(blob)) {
      fromMsg.relativePath = 'index.html';
      fromMsg.absoluteFile = fromMsg.root + '/index.html';
    }
  }

  if (fromMsg) return fromMsg;

  const slug = projectSlug(userMessage, goal || (briefing && briefing.goal));
  let relativePath = null;
  const asFile = blob.match(
    /\bas\s+([A-Za-z0-9._/-]+\.(?:html?|css|js))\b/i,
  );
  if (asFile) relativePath = asFile[1].replace(/^\/+/, '');
  else if (/\bindex\.html\b/i.test(blob) && /\bcalculator\b/i.test(blob)) {
    relativePath = 'index.html';
  }
  return {
    slug,
    relativePath,
    absoluteFile: relativePath
      ? '/home/user/projects/' + slug + '/' + relativePath
      : null,
    root: '/home/user/projects/' + slug,
    source: 'slug',
  };
}

function isGameLikeRequest(userMessage, goal) {
  const blob = String(userMessage || '') + ' ' + String(goal || '');
  return /\b(game|shooter|fps|canvas|bubble.?shooter|ops|arena|combat|rac(e|ing)|kart)\b/i.test(
    blob,
  );
}

function isRacingRequest(userMessage, goal) {
  const blob = String(userMessage || '') + ' ' + String(goal || '');
  return /\b(rac(e|ing)|kart|grand\s*prix|lap\s*race|need\s*for\s*speed)\b/i.test(
    blob,
  );
}

function isShooterRequest(userMessage, goal) {
  const blob = String(userMessage || '') + ' ' + String(goal || '');
  return /\b(shoot|ops|fps|3d|arena|combat|gun|ammo)\b/i.test(blob);
}

function wantsTwoPlayer(userMessage, goal) {
  const blob = String(userMessage || '') + ' ' + String(goal || '');
  return /\b(2[\s-]?player|two[\s-]?player|multiplayer|vs\s*(a\s*)?friend|local\s*co[\s-]?op|build\s+a\s*2\b|\ba\s*2\s+(rac|player|car)|\b2\s+(rac(?:e|ing)?|player|cars?))\b/i.test(
    blob,
  );
}

/**
 * Short product-style title — never paste the full user prompt into <title>/HUD.
 */
function friendlyProjectTitle(userMessage, goal, slug) {
  const blob = String(userMessage || '') + ' ' + String(goal || '');
  if (isRacingRequest(userMessage, goal)) {
    return wantsTwoPlayer(userMessage, goal) ? 'Twin Lane Rally' : 'Neon Circuit';
  }
  if (isShooterRequest(userMessage, goal)) return 'Ops Arena';
  if (/\bcalculator\b/i.test(blob)) return 'Calculator';
  if (/\bbubble/i.test(blob)) return 'Bubble Shooter';
  const fromSlug = String(slug || '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  if (fromSlug && fromSlug.length >= 2 && fromSlug.length <= 32) return fromSlug;
  if (/\bgame\b/i.test(blob)) return 'Canvas Game';
  return 'Mini App';
}

function isCalculatorRequest(userMessage, goal) {
  const blob = String(userMessage || '') + ' ' + String(goal || '');
  return /\bcalculator\b/i.test(blob);
}

/**
 * Tiny/hello/single-file page — must not get a playable multi-file game scaffold.
 */
function isMinimalPageRequest(userMessage, goal) {
  const blob = String(userMessage || '') + ' ' + String(goal || '');
  const lower = blob.toLowerCase();
  if (isGameLikeRequest(userMessage, goal) || isCalculatorRequest(userMessage, goal)) {
    return false;
  }
  if (
    /\b(write only|only that file|just (an? )?h1|hello[\s-]?world|one[\s-]?page|single[\s-]?file|minimal|tiny)\b/i.test(
      blob,
    )
  ) {
    return true;
  }
  const paths = blob.match(/\/home\/user\/projects\/[^\s`'"\])|,]+/g) || [];
  if (
    paths.length === 1 &&
    /\.html?\b/i.test(paths[0]) &&
    !/\b(style\.css|script\.js|game\.js|readme)\b/i.test(lower)
  ) {
    return true;
  }
  return false;
}

function extractHeadingText(userMessage, goal) {
  const blob = String(userMessage || '') + ' ' + String(goal || '');
  let m = blob.match(/\bh1\b[^.!?\n]{0,40}?\bsaying\s+["']?([^"'.!\n]+)["']?/i);
  if (m) return m[1].trim().slice(0, 80);
  m = blob.match(/["'](Hello[^"']{0,40})["']/i);
  if (m) return m[1].trim().slice(0, 80);
  if (/hello\s*chatre/i.test(blob)) return 'Hello Chatre';
  if (/hello[\s-]*world/i.test(blob)) return 'Hello World';
  return 'Hello';
}

function constrainFilesToRequest(files, target, minimal) {
  const list = Array.isArray(files) ? files.slice() : [];
  if (!minimal || !list.length) return list;
  const prefer =
    (target && target.relativePath) ||
    'index.html';
  const exact = list.find(
    (f) =>
      f.relativePath === prefer ||
      String(f.relativePath || '').endsWith('/' + prefer),
  );
  if (exact) {
    return [{ relativePath: prefer, content: exact.content }];
  }
  const html = list.find((f) => /\.html?$/i.test(f.relativePath || ''));
  if (html) {
    return [{ relativePath: prefer, content: html.content }];
  }
  return [{ relativePath: prefer, content: list[0].content }];
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
    /```/.test(t) ||
    /<!DOCTYPE html|<canvas|const canvas|getElementById\(['"]display/i.test(t);
  const tutorialDump =
    /what would you like to do next|next prompts:|basic calculator implementation|in style\.css file|in script\.js file/i.test(
      t,
    );
  return (
    claimsWrite ||
    tutorialDump ||
    (hasCodeDump &&
      /bubble|game|index\.html|calculator|style\.css|script\.js/i.test(t))
  );
}

/**
 * Build prompt for structured multi-file generation.
 * Prefer markdown fences (real newlines) over JSON — models often dump
 * "index.html": "<!DOCTYPE…\\n…" which then lands as garbage delivery.
 */
function buildFilesPrompt(userMessage, goal, slug, opts) {
  const o = opts || {};
  const minimal = !!o.minimal || isMinimalPageRequest(userMessage, goal);
  const prefer = o.preferredFile || 'index.html';
  if (minimal) {
    return (
      'Generate a minimal HTML deliverable. Output ONLY markdown file fences — no JSON, no prose, no tool blocks.\n' +
      'Format exactly:\n\n' +
      '### ' +
      prefer +
      '\n```html\n…full file with real newlines…\n```\n\n' +
      'Rules:\n' +
      '- Return ONLY the file(s) the user asked for — usually a single HTML file.\n' +
      '- Do NOT add style.css, script.js, game.js, README, or extras unless the user asked.\n' +
      '- Match any exact path/filename the user gave.\n' +
      '- Put real newlines in the fence body — never write \\n escape sequences as text.\n' +
      '- Project slug hint: ' +
      slug +
      '\n\nUser request:\n' +
      String(userMessage || '') +
      '\n\nGoal: ' +
      String(goal || '')
    );
  }
  return (
    'Generate a working mini project. Output ONLY markdown file fences — no JSON object, no prose, no tool blocks.\n' +
    'Format exactly (one or more files):\n\n' +
    '### index.html\n```html\n…\n```\n\n' +
    '### style.css\n```css\n…\n```\n\n' +
    '(omit css/js files unless needed)\n\n' +
    'Rules:\n' +
    '- Every fence body is FULL file content with real newlines (not \\n text).\n' +
    '- Use the fewest files needed.\n' +
    '- If the user named an exact path or "only that file", return only that file.\n' +
    '- Make it actually work in a browser (canvas or DOM).\n' +
    '- For polished apps/games: intentional typography and contrast — not a bare white page.\n' +
    '- Pick a short product title for <title>/HUD — never paste the full user prompt as the brand name.\n' +
    '- Match the genre: racing → top-down cars + laps (not ammo/HP); shooter → combat; calculator → keypad.\n' +
    '- Prefer vanilla HTML/CSS/JS that runs offline (canvas OK). Only add a CDN library if the user asked for frameworks.\n' +
    '- Project slug hint: ' +
    slug +
    '\n\nUser request:\n' +
    String(userMessage || '') +
    '\n\nGoal: ' +
    String(goal || '')
  );
}

/**
 * If a string still looks like JSON-escaped source (literal \\n, \\\"), unescape once.
 */
function unescapeFileContent(raw) {
  let s = String(raw == null ? '' : raw);
  // Whole value wrapped in quotes
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    try {
      const once = JSON.parse(s.startsWith("'") ? '"' + s.slice(1, -1).replace(/"/g, '\\"') + '"' : s);
      if (typeof once === 'string') s = once;
    } catch {
      s = s.slice(1, -1);
    }
  }
  const hasRealNewline = s.indexOf('\n') >= 0;
  const hasEscapedNewline = /\\n/.test(s);
  if (!hasRealNewline && hasEscapedNewline) {
    s = s
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return s;
}

/**
 * Detect and unwrap a mistaken JSON "files" blob written as a single file body.
 * Returns { files:[{relativePath,content}] } or null.
 */
function unwrapFilesJsonBlob(raw) {
  const s = String(raw || '').trim();
  if (!s || s[0] !== '{') return null;
  if (
    !/"files"\s*:/.test(s) &&
    !/"[^"]+\.(html?|css|js|json|md)"\s*:/.test(s)
  ) {
    return null;
  }
  return parseGeneratedFiles(s);
}

function filesFromObjectMap(map) {
  const out = [];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, val] of Object.entries(map)) {
    if (key === 'slug' || key === 'files' || key === 'name' || key === 'project') {
      continue;
    }
    if (typeof val !== 'string') continue;
    const path = String(key)
      .replace(/^\/+/, '')
      .replace(/^home\/user\/projects\/[^/]+\//, '')
      .trim();
    if (!path || !/\.[A-Za-z0-9]+$/.test(path)) continue;
    const content = unescapeFileContent(val);
    if (!content || content.length < 8) continue;
    out.push({ relativePath: path, content });
  }
  return out;
}

function parseGeneratedFiles(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // Prefer fenced / labeled extraction first (real newlines).
  const fromNarration = extractFilesFromNarration(raw);
  if (fromNarration && fromNarration.length) {
    return {
      slug: null,
      files: fromNarration.map((f) => ({
        relativePath: f.relativePath,
        content: unescapeFileContent(f.content),
      })),
    };
  }

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

  const out = [];
  if (Array.isArray(obj.files)) {
    for (const f of obj.files) {
      if (!f || typeof f !== 'object') continue;
      const path = String(f.path || f.name || '')
        .replace(/^\/+/, '')
        .trim();
      const content = unescapeFileContent(f.content || f.body || '');
      if (!path || !content) continue;
      out.push({ relativePath: path, content });
    }
  } else if (obj.files && typeof obj.files === 'object') {
    out.push.apply(out, filesFromObjectMap(obj.files));
  }
  // Top-level map: { "index.html": "<!DOCTYPE…>", "style.css": "…" }
  if (!out.length) {
    out.push.apply(out, filesFromObjectMap(obj));
  }
  if (!out.length) return null;
  return { slug, files: out };
}

/**
 * Deterministic playable HTML/CSS/JS scaffold when the LLM cannot generate
 * (credits, truncated JSON, etc.). Prefer a real game over empty workspace.
 */
function scaffoldCalculatorProject(slug, title) {
  const name = String(slug || 'calculator');
  const safeTitle = String(title || 'Calculator').replace(/</g, '').slice(0, 60);
  return {
    slug: name,
    files: [
      {
        relativePath: 'index.html',
        content:
          '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
          '  <meta charset="UTF-8" />\n' +
          '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
          '  <title>' +
          safeTitle +
          '</title>\n' +
          '  <link rel="stylesheet" href="style.css" />\n' +
          '</head>\n<body>\n' +
          '  <main class="calc" aria-label="Calculator">\n' +
          '    <div id="display" class="display" role="status" aria-live="polite">0</div>\n' +
          '    <div class="keys">\n' +
          '      <button type="button" data-action="clear">C</button>\n' +
          '      <button type="button" data-action="sign">±</button>\n' +
          '      <button type="button" data-action="percent">%</button>\n' +
          '      <button type="button" data-op="/">÷</button>\n' +
          '      <button type="button" data-num="7">7</button>\n' +
          '      <button type="button" data-num="8">8</button>\n' +
          '      <button type="button" data-num="9">9</button>\n' +
          '      <button type="button" data-op="*">×</button>\n' +
          '      <button type="button" data-num="4">4</button>\n' +
          '      <button type="button" data-num="5">5</button>\n' +
          '      <button type="button" data-num="6">6</button>\n' +
          '      <button type="button" data-op="-">−</button>\n' +
          '      <button type="button" data-num="1">1</button>\n' +
          '      <button type="button" data-num="2">2</button>\n' +
          '      <button type="button" data-num="3">3</button>\n' +
          '      <button type="button" data-op="+">+</button>\n' +
          '      <button type="button" class="span-2" data-num="0">0</button>\n' +
          '      <button type="button" data-action="dot">.</button>\n' +
          '      <button type="button" data-action="equals">=</button>\n' +
          '    </div>\n' +
          '  </main>\n' +
          '  <script src="script.js"></script>\n' +
          '</body>\n</html>\n',
      },
      {
        relativePath: 'style.css',
        content:
          ':root {\n' +
          '  --bg: #12141a;\n' +
          '  --panel: #1c2030;\n' +
          '  --key: #2a3148;\n' +
          '  --key-op: #3d4a6b;\n' +
          '  --accent: #6ea8ff;\n' +
          '  --text: #f2f5ff;\n' +
          '}\n' +
          '* { box-sizing: border-box; }\n' +
          'body {\n' +
          '  min-height: 100vh; margin: 0; display: grid; place-items: center;\n' +
          '  background: radial-gradient(ellipse at top, #1a2238, var(--bg));\n' +
          '  font-family: "Segoe UI", system-ui, sans-serif; color: var(--text);\n' +
          '}\n' +
          '.calc {\n' +
          '  width: min(92vw, 320px); padding: 18px; border-radius: 18px;\n' +
          '  background: var(--panel); box-shadow: 0 18px 50px rgba(0,0,0,.45);\n' +
          '}\n' +
          '.display {\n' +
          '  min-height: 64px; margin-bottom: 14px; padding: 12px 14px;\n' +
          '  border-radius: 12px; background: #0d1018; text-align: right;\n' +
          '  font-size: 2rem; font-variant-numeric: tabular-nums; overflow: hidden;\n' +
          '}\n' +
          '.keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }\n' +
          'button {\n' +
          '  border: 0; border-radius: 12px; padding: 16px 0; font-size: 1.15rem;\n' +
          '  background: var(--key); color: var(--text); cursor: pointer;\n' +
          '}\n' +
          'button:hover { filter: brightness(1.12); }\n' +
          'button[data-op], button[data-action="equals"] { background: var(--key-op); color: var(--accent); }\n' +
          '.span-2 { grid-column: span 2; }\n',
      },
      {
        relativePath: 'script.js',
        content:
          '(function () {\n' +
          '  "use strict";\n' +
          '  var display = document.getElementById("display");\n' +
          '  var current = "0";\n' +
          '  var previous = null;\n' +
          '  var op = null;\n' +
          '  var fresh = true;\n' +
          '\n' +
          '  function show() {\n' +
          '    display.textContent = current;\n' +
          '  }\n' +
          '\n' +
          '  function inputNum(n) {\n' +
          '    if (fresh || current === "0") {\n' +
          '      current = n;\n' +
          '      fresh = false;\n' +
          '    } else if (current.length < 14) {\n' +
          '      current += n;\n' +
          '    }\n' +
          '    show();\n' +
          '  }\n' +
          '\n' +
          '  function inputDot() {\n' +
          '    if (fresh) {\n' +
          '      current = "0.";\n' +
          '      fresh = false;\n' +
          '    } else if (current.indexOf(".") < 0) {\n' +
          '      current += ".";\n' +
          '    }\n' +
          '    show();\n' +
          '  }\n' +
          '\n' +
          '  function compute() {\n' +
          '    if (previous == null || !op) return;\n' +
          '    var a = Number(previous);\n' +
          '    var b = Number(current);\n' +
          '    var r = 0;\n' +
          '    if (op === "+") r = a + b;\n' +
          '    else if (op === "-") r = a - b;\n' +
          '    else if (op === "*") r = a * b;\n' +
          '    else if (op === "/") r = b === 0 ? NaN : a / b;\n' +
          '    current = Number.isFinite(r)\n' +
          '      ? String(Number(r.toPrecision(12)))\n' +
          '      : "Error";\n' +
          '    previous = null;\n' +
          '    op = null;\n' +
          '    fresh = true;\n' +
          '    show();\n' +
          '  }\n' +
          '\n' +
          '  document.querySelector(".keys").addEventListener("click", function (e) {\n' +
          '    var btn = e.target.closest("button");\n' +
          '    if (!btn) return;\n' +
          '    if (btn.dataset.num != null) return inputNum(btn.dataset.num);\n' +
          '    if (btn.dataset.action === "dot") return inputDot();\n' +
          '    if (btn.dataset.action === "clear") {\n' +
          '      current = "0"; previous = null; op = null; fresh = true; return show();\n' +
          '    }\n' +
          '    if (btn.dataset.action === "sign") {\n' +
          '      if (current !== "0" && current !== "Error") {\n' +
          '        current = current.charAt(0) === "-" ? current.slice(1) : "-" + current;\n' +
          '      }\n' +
          '      return show();\n' +
          '    }\n' +
          '    if (btn.dataset.action === "percent") {\n' +
          '      current = String(Number(current) / 100);\n' +
          '      fresh = true;\n' +
          '      return show();\n' +
          '    }\n' +
          '    if (btn.dataset.action === "equals") return compute();\n' +
          '    if (btn.dataset.op) {\n' +
          '      if (previous != null && op && !fresh) compute();\n' +
          '      previous = current;\n' +
          '      op = btn.dataset.op;\n' +
          '      fresh = true;\n' +
          '    }\n' +
          '  });\n' +
          '})();\n',
      },
      {
        relativePath: 'README.md',
        content:
          '# ' +
          safeTitle +
          '\n\nOpen `index.html` in a browser.\n',
      },
    ],
  };
}

function scaffoldMinimalHtml(slug, userMessage, goal, opts) {
  const name = String(slug || 'hello');
  const o = opts || {};
  const rel = o.relativePath || 'index.html';
  const heading = extractHeadingText(userMessage, goal).replace(/</g, '');
  const content =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="UTF-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '  <title>' +
    heading +
    '</title>\n' +
    '</head>\n<body>\n' +
    '  <h1>' +
    heading +
    '</h1>\n' +
    '</body>\n</html>\n';
  return {
    slug: name,
    files: [{ relativePath: rel, content: content }],
    kind: 'minimal',
  };
}

function scaffoldHtmlProject(slug, userMessage, goal, opts) {
  const name = String(slug || 'project');
  const o = opts || {};
  if (o.minimal || isMinimalPageRequest(userMessage, goal)) {
    return scaffoldMinimalHtml(name, userMessage, goal, o);
  }
  const title = friendlyProjectTitle(userMessage, goal, name);
  const blob = title + ' ' + String(userMessage || '') + ' ' + String(goal || '');
  if (/\bcalculator\b/i.test(blob)) {
    return scaffoldCalculatorProject(name, title);
  }
  // Non-game generic apps: still prefer a simple page over a shooter HUD
  if (!isGameLikeRequest(userMessage, goal)) {
    return scaffoldMinimalHtml(name, userMessage, goal, o);
  }
  if (isRacingRequest(userMessage, goal)) {
    return scaffoldRacingProject(name, title, {
      twoPlayer: wantsTwoPlayer(userMessage, goal),
    });
  }
  if (isShooterRequest(userMessage, goal)) {
    return scaffoldShooterProject(name, title);
  }
  return scaffoldClickerProject(name, title);
}

function scaffoldShooterProject(name, title) {
  const safe = String(title || 'Ops Arena').replace(/</g, '').slice(0, 60);
  const indexHtml =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="UTF-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '  <title>' +
    safe +
    '</title>\n' +
    '  <link rel="stylesheet" href="style.css" />\n' +
    '</head>\n<body>\n' +
    '  <div id="hud">\n' +
    '    <div class="brand">' +
    safe +
    '</div>\n' +
    '    <div class="stats">Score <span id="score">0</span> · Ammo <span id="ammo">30</span> · HP <span id="hp">100</span></div>\n' +
    '  </div>\n' +
    '  <canvas id="game"></canvas>\n' +
    '  <div id="overlay">\n' +
    '    <h1>' +
    safe +
    '</h1>\n' +
    '    <p>Click to lock pointer · WASD move · Mouse look · Click shoot · R reload</p>\n' +
    '    <button id="start">Start mission</button>\n' +
    '  </div>\n' +
    '  <script src="game.js"></script>\n' +
    '</body>\n</html>\n';

  const styleCss =
    ':root {\n' +
    '  --bg: #0b1210;\n' +
    '  --panel: rgba(12, 28, 22, 0.82);\n' +
    '  --accent: #7dffb3;\n' +
    '  --warn: #ffb347;\n' +
    '  --text: #e8f5ee;\n' +
    '  --muted: #8aa898;\n' +
    '}\n' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    'html, body { width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--text);\n' +
    '  font-family: "Segoe UI", "Trebuchet MS", sans-serif; }\n' +
    '#game { display: block; width: 100vw; height: 100vh; cursor: crosshair; background: #06100c; }\n' +
    '#hud { position: fixed; inset: 0 auto auto 0; width: 100%; padding: 14px 18px; pointer-events: none;\n' +
    '  display: flex; justify-content: space-between; align-items: flex-start;\n' +
    '  background: linear-gradient(180deg, rgba(0,0,0,.55), transparent); z-index: 2; }\n' +
    '.brand { font-weight: 700; letter-spacing: 0.04em; color: var(--accent); text-transform: uppercase; font-size: 13px; }\n' +
    '.stats { font-variant-numeric: tabular-nums; color: var(--text); font-size: 14px; }\n' +
    '#overlay { position: fixed; inset: 0; display: grid; place-items: center; text-align: center;\n' +
    '  background: radial-gradient(ellipse at center, rgba(8,30,22,.92), rgba(4,10,8,.96)); z-index: 3; }\n' +
    '#overlay.hidden { display: none; }\n' +
    '#overlay h1 { font-size: clamp(1.6rem, 4vw, 2.6rem); margin-bottom: 10px; color: var(--accent); }\n' +
    '#overlay p { color: var(--muted); max-width: 28rem; margin: 0 auto 18px; line-height: 1.45; }\n' +
    '#start { border: 1px solid var(--accent); background: transparent; color: var(--accent);\n' +
    '  padding: 10px 22px; font-size: 15px; cursor: pointer; letter-spacing: 0.06em; text-transform: uppercase; }\n' +
    '#start:hover { background: var(--accent); color: #04140c; }\n';

  return {
    slug: name,
    files: [
      { relativePath: 'index.html', content: indexHtml },
      { relativePath: 'style.css', content: styleCss },
      { relativePath: 'game.js', content: scaffoldOpsShooterJs() },
      {
        relativePath: 'README.md',
        content:
          '# ' +
          safe +
          '\n\nOpen `index.html` in a browser.\n\nControls: WASD, mouse look, click to shoot, R reload.\n',
      },
    ],
    kind: 'shooter',
  };
}

function scaffoldClickerProject(name, title) {
  const safe = String(title || 'Canvas Game').replace(/</g, '').slice(0, 60);
  const indexHtml =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="UTF-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '  <title>' +
    safe +
    '</title>\n' +
    '  <link rel="stylesheet" href="style.css" />\n' +
    '</head>\n<body>\n' +
    '  <div id="hud">\n' +
    '    <div class="brand">' +
    safe +
    '</div>\n' +
    '    <div class="stats">Score <span id="score">0</span></div>\n' +
    '  </div>\n' +
    '  <canvas id="game"></canvas>\n' +
    '  <div id="overlay">\n' +
    '    <h1>' +
    safe +
    '</h1>\n' +
    '    <p>Click the target to score. It gets faster each hit.</p>\n' +
    '    <button id="start">Play</button>\n' +
    '  </div>\n' +
    '  <script src="game.js"></script>\n' +
    '</body>\n</html>\n';

  const styleCss =
    ':root { --bg:#0b1210; --accent:#7dffb3; --text:#e8f5ee; --muted:#8aa898; }\n' +
    '* { box-sizing:border-box; margin:0; padding:0; }\n' +
    'html, body { width:100%; height:100%; overflow:hidden; background:var(--bg); color:var(--text);\n' +
    '  font-family:"Segoe UI","Trebuchet MS",sans-serif; }\n' +
    '#game { display:block; width:100vw; height:100vh; cursor:crosshair; background:#06100c; }\n' +
    '#hud { position:fixed; inset:0 auto auto 0; width:100%; padding:14px 18px; pointer-events:none;\n' +
    '  display:flex; justify-content:space-between; z-index:2;\n' +
    '  background:linear-gradient(180deg, rgba(0,0,0,.55), transparent); }\n' +
    '.brand { font-weight:700; letter-spacing:.04em; color:var(--accent); text-transform:uppercase; font-size:13px; }\n' +
    '.stats { font-variant-numeric:tabular-nums; }\n' +
    '#overlay { position:fixed; inset:0; display:grid; place-items:center; text-align:center; z-index:3;\n' +
    '  background:radial-gradient(ellipse at center, rgba(8,30,22,.92), rgba(4,10,8,.96)); }\n' +
    '#overlay.hidden { display:none; }\n' +
    '#overlay h1 { color:var(--accent); margin-bottom:10px; }\n' +
    '#overlay p { color:var(--muted); max-width:28rem; margin:0 auto 18px; }\n' +
    '#start { border:1px solid var(--accent); background:transparent; color:var(--accent);\n' +
    '  padding:10px 22px; cursor:pointer; text-transform:uppercase; letter-spacing:.06em; }\n' +
    '#start:hover { background:var(--accent); color:#04140c; }\n';

  return {
    slug: name,
    files: [
      { relativePath: 'index.html', content: indexHtml },
      { relativePath: 'style.css', content: styleCss },
      { relativePath: 'game.js', content: scaffoldSimpleCanvasJs(safe) },
      {
        relativePath: 'README.md',
        content: '# ' + safe + '\n\nOpen `index.html` and click the target.\n',
      },
    ],
    kind: 'clicker',
  };
}

function scaffoldRacingProject(name, title, opts) {
  const o = opts || {};
  const two = !!o.twoPlayer;
  const safe = String(title || (two ? 'Twin Lane Rally' : 'Neon Circuit'))
    .replace(/</g, '')
    .slice(0, 60);
  const controls = two
    ? 'P1: WASD · P2: Arrow keys · first to 3 laps wins'
    : 'Arrow keys or WASD · beat the AI to 3 laps';
  const indexHtml =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="UTF-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '  <title>' +
    safe +
    '</title>\n' +
    '  <link rel="stylesheet" href="style.css" />\n' +
    '</head>\n<body>\n' +
    '  <div id="hud">\n' +
    '    <div class="brand">' +
    safe +
    '</div>\n' +
    '    <div class="stats" id="stats">Lap — · Speed —</div>\n' +
    '  </div>\n' +
    '  <canvas id="game"></canvas>\n' +
    '  <div id="overlay">\n' +
    '    <h1>' +
    safe +
    '</h1>\n' +
    '    <p>' +
    controls +
    '</p>\n' +
    '    <button id="start">Start race</button>\n' +
    '  </div>\n' +
    '  <script src="game.js"></script>\n' +
    '</body>\n</html>\n';

  const styleCss =
    ':root {\n' +
    '  --bg: #070b14;\n' +
    '  --accent: #5ce1ff;\n' +
    '  --accent-2: #ff5c8a;\n' +
    '  --text: #eef6ff;\n' +
    '  --muted: #8aa0b8;\n' +
    '}\n' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    'html, body { width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--text);\n' +
    '  font-family: "Trebuchet MS", "Segoe UI", sans-serif; }\n' +
    '#game { display: block; width: 100vw; height: 100vh; background: #0a1220; }\n' +
    '#hud { position: fixed; inset: 0 auto auto 0; width: 100%; padding: 14px 18px; pointer-events: none;\n' +
    '  display: flex; justify-content: space-between; align-items: flex-start; z-index: 2;\n' +
    '  background: linear-gradient(180deg, rgba(0,0,0,.5), transparent); }\n' +
    '.brand { font-weight: 800; letter-spacing: 0.08em; color: var(--accent); text-transform: uppercase; font-size: 13px; }\n' +
    '.stats { font-variant-numeric: tabular-nums; font-size: 14px; }\n' +
    '#overlay { position: fixed; inset: 0; display: grid; place-items: center; text-align: center; z-index: 3;\n' +
    '  background: radial-gradient(ellipse at center, rgba(10,24,48,.94), rgba(4,8,16,.97)); }\n' +
    '#overlay.hidden { display: none; }\n' +
    '#overlay h1 { font-size: clamp(1.7rem, 4vw, 2.8rem); margin-bottom: 10px; color: var(--accent); }\n' +
    '#overlay p { color: var(--muted); max-width: 28rem; margin: 0 auto 18px; line-height: 1.45; }\n' +
    '#start { border: 1px solid var(--accent); background: transparent; color: var(--accent);\n' +
    '  padding: 10px 22px; font-size: 15px; cursor: pointer; letter-spacing: 0.06em; text-transform: uppercase; }\n' +
    '#start:hover { background: var(--accent); color: #041018; }\n';

  return {
    slug: name,
    files: [
      { relativePath: 'index.html', content: indexHtml },
      { relativePath: 'style.css', content: styleCss },
      {
        relativePath: 'game.js',
        content: scaffoldRacingJs({ twoPlayer: two, title: safe }),
      },
      {
        relativePath: 'README.md',
        content:
          '# ' +
          safe +
          '\n\nTop-down HTML canvas racer (vanilla JS — no CDN required).\n\n' +
          controls +
          '\n\nOpen `index.html` or use Chatre live preview.\n',
      },
    ],
    kind: 'racing',
  };
}

function scaffoldRacingJs(opts) {
  const o = opts || {};
  const two = !!o.twoPlayer;
  const title = String(o.title || 'Racing').replace(/\\/g, '').replace(/'/g, "\\'");
  return (
    '(function () {\n' +
    '  "use strict";\n' +
    '  const twoPlayer = ' +
    (two ? 'true' : 'false') +
    ';\n' +
    '  const canvas = document.getElementById("game");\n' +
    '  const ctx = canvas.getContext("2d");\n' +
    '  const overlay = document.getElementById("overlay");\n' +
    '  const startBtn = document.getElementById("start");\n' +
    '  const statsEl = document.getElementById("stats");\n' +
    '  let W = 0, H = 0, running = false, last = 0, winner = "";\n' +
    '  const keys = Object.create(null);\n' +
    '  const LAP_TARGET = 3;\n' +
    '  const cx = () => W * 0.5, cy = () => H * 0.52;\n' +
    '  const trackR = () => Math.min(W, H) * 0.34;\n' +
    '  const roadW = () => Math.min(W, H) * 0.11;\n' +
    '\n' +
    '  function car(color, angle) {\n' +
    '    return { angle: angle, speed: 0, lap: 0, progress: 0, color: color, finished: false };\n' +
    '  }\n' +
    '  let p1 = car("#5ce1ff", -Math.PI / 2);\n' +
    '  let p2 = car("#ff5c8a", -Math.PI / 2 - 0.12);\n' +
    '\n' +
    '  function resize() {\n' +
    '    W = canvas.width = window.innerWidth;\n' +
    '    H = canvas.height = window.innerHeight;\n' +
    '  }\n' +
    '  window.addEventListener("resize", resize);\n' +
    '  resize();\n' +
    '\n' +
    '  function reset() {\n' +
    '    p1 = car("#5ce1ff", -Math.PI / 2);\n' +
    '    p2 = car("#ff5c8a", -Math.PI / 2 - 0.12);\n' +
    '    winner = "";\n' +
    '    syncHud();\n' +
    '  }\n' +
    '\n' +
    '  function syncHud() {\n' +
    '    const spd = Math.abs(p1.speed) | 0;\n' +
    '    if (twoPlayer) {\n' +
    '      statsEl.textContent = "P1 L" + p1.lap + "/" + LAP_TARGET + " · P2 L" + p2.lap + "/" + LAP_TARGET + " · " + spd + " u/s";\n' +
    '    } else {\n' +
    '      statsEl.textContent = "You L" + p1.lap + "/" + LAP_TARGET + " · AI L" + p2.lap + "/" + LAP_TARGET + " · " + spd + " u/s";\n' +
    '    }\n' +
    '  }\n' +
    '\n' +
    '  function onTrack(angle, lane) {\n' +
    '    const r = trackR() + lane;\n' +
    '    return { x: cx() + Math.cos(angle) * r, y: cy() + Math.sin(angle) * r * 0.72 };\n' +
    '  }\n' +
    '\n' +
    '  function steerCar(c, left, right, up, down, dt, ai) {\n' +
    '    if (c.finished) return;\n' +
    '    const accel = 140, brake = 180, drag = 48, turn = 2.4;\n' +
    '    if (ai) {\n' +
    '      // Gentle AI: hold throttle, slight noise\n' +
    '      up = true; left = Math.sin(performance.now() / 900) > 0.7;\n' +
    '      right = Math.sin(performance.now() / 700) < -0.7;\n' +
    '    }\n' +
    '    if (up) c.speed += accel * dt;\n' +
    '    if (down) c.speed -= brake * dt;\n' +
    '    c.speed -= Math.sign(c.speed) * Math.min(Math.abs(c.speed), drag * dt);\n' +
    '    c.speed = Math.max(-60, Math.min(220, c.speed));\n' +
    '    const steer = (right ? 1 : 0) - (left ? 1 : 0);\n' +
    '    c.angle += steer * turn * (0.35 + Math.abs(c.speed) / 220) * dt;\n' +
    '    const prev = c.progress;\n' +
    '    c.progress += (c.speed * dt) / (trackR() * Math.PI * 2);\n' +
    '    // Crossing start/finish (progress wraps via angle)\n' +
    '    const a0 = ((prev % 1) + 1) % 1;\n' +
    '    const a1 = ((c.progress % 1) + 1) % 1;\n' +
    '    if (c.speed > 0 && a0 > 0.85 && a1 < 0.15) {\n' +
    '      c.lap += 1;\n' +
    '      if (c.lap >= LAP_TARGET) { c.finished = true; c.speed = 0; if (!winner) winner = c.color === "#5ce1ff" ? "P1" : (twoPlayer ? "P2" : "AI"); }\n' +
    '    }\n' +
    '    c.angle = -Math.PI / 2 + c.progress * Math.PI * 2;\n' +
    '  }\n' +
    '\n' +
    '  function drawTrack() {\n' +
    '    ctx.fillStyle = "#0a1220";\n' +
    '    ctx.fillRect(0, 0, W, H);\n' +
    '    // grass\n' +
    '    ctx.fillStyle = "#12301c";\n' +
    '    ctx.beginPath();\n' +
    '    ctx.ellipse(cx(), cy(), trackR() + roadW() + 36, (trackR() + roadW() + 36) * 0.72, 0, 0, Math.PI * 2);\n' +
    '    ctx.fill();\n' +
    '    // asphalt\n' +
    '    ctx.strokeStyle = "#2a3348";\n' +
    '    ctx.lineWidth = roadW() * 2;\n' +
    '    ctx.beginPath();\n' +
    '    ctx.ellipse(cx(), cy(), trackR(), trackR() * 0.72, 0, 0, Math.PI * 2);\n' +
    '    ctx.stroke();\n' +
    '    // center line\n' +
    '    ctx.strokeStyle = "rgba(255,255,255,.35)";\n' +
    '    ctx.setLineDash([14, 16]);\n' +
    '    ctx.lineWidth = 2;\n' +
    '    ctx.beginPath();\n' +
    '    ctx.ellipse(cx(), cy(), trackR(), trackR() * 0.72, 0, 0, Math.PI * 2);\n' +
    '    ctx.stroke();\n' +
    '    ctx.setLineDash([]);\n' +
    '    // start/finish\n' +
    '    const a = -Math.PI / 2;\n' +
    '    const inner = onTrack(a, -roadW() * 0.9);\n' +
    '    const outer = onTrack(a, roadW() * 0.9);\n' +
    '    ctx.strokeStyle = "#fff";\n' +
    '    ctx.lineWidth = 4;\n' +
    '    ctx.beginPath(); ctx.moveTo(inner.x, inner.y); ctx.lineTo(outer.x, outer.y); ctx.stroke();\n' +
    '  }\n' +
    '\n' +
    '  function drawCar(c, lane) {\n' +
    '    const p = onTrack(c.angle, lane);\n' +
    '    const tang = c.angle + Math.PI / 2;\n' +
    '    ctx.save();\n' +
    '    ctx.translate(p.x, p.y);\n' +
    '    ctx.rotate(tang);\n' +
    '    ctx.fillStyle = c.color;\n' +
    '    ctx.fillRect(-10, -6, 20, 12);\n' +
    '    ctx.fillStyle = "rgba(0,0,0,.35)";\n' +
    '    ctx.fillRect(2, -4, 6, 8);\n' +
    '    ctx.restore();\n' +
    '  }\n' +
    '\n' +
    '  function frame(now) {\n' +
    '    if (!running) return;\n' +
    '    const dt = Math.min(0.033, (now - last) / 1000) || 0.016;\n' +
    '    last = now;\n' +
    '    if (twoPlayer) {\n' +
    '      steerCar(p1, keys["a"] || keys["A"], keys["d"] || keys["D"], keys["w"] || keys["W"], keys["s"] || keys["S"], dt, false);\n' +
    '      steerCar(p2, keys["ArrowLeft"], keys["ArrowRight"], keys["ArrowUp"], keys["ArrowDown"], dt, false);\n' +
    '    } else {\n' +
    '      steerCar(p1, keys["a"] || keys["A"] || keys["ArrowLeft"], keys["d"] || keys["D"] || keys["ArrowRight"], keys["w"] || keys["W"] || keys["ArrowUp"], keys["s"] || keys["S"] || keys["ArrowDown"], dt, false);\n' +
    '      steerCar(p2, false, false, true, false, dt, true);\n' +
    '    }\n' +
    '    drawTrack();\n' +
    '    drawCar(p1, -roadW() * 0.35);\n' +
    '    drawCar(p2, roadW() * 0.35);\n' +
    '    syncHud();\n' +
    '    if (winner) {\n' +
    '      running = false;\n' +
    '      overlay.classList.remove("hidden");\n' +
    '      overlay.querySelector("h1").textContent = winner + " wins!";\n' +
    '      overlay.querySelector("p").textContent = "' +
    title +
    ' — rematch?";\n' +
    '      startBtn.textContent = "Race again";\n' +
    '      return;\n' +
    '    }\n' +
    '    requestAnimationFrame(frame);\n' +
    '  }\n' +
    '\n' +
    '  window.addEventListener("keydown", function (e) { keys[e.key] = true; if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].indexOf(e.key) >= 0) e.preventDefault(); });\n' +
    '  window.addEventListener("keyup", function (e) { keys[e.key] = false; });\n' +
    '\n' +
    '  startBtn.addEventListener("click", function () {\n' +
    '    reset();\n' +
    '    overlay.classList.add("hidden");\n' +
    '    running = true;\n' +
    '    last = performance.now();\n' +
    '    requestAnimationFrame(frame);\n' +
    '  });\n' +
    '})();\n'
  );
}

function scaffoldOpsShooterJs() {
  return (
    '(function () {\n' +
    '  "use strict";\n' +
    '  const canvas = document.getElementById("game");\n' +
    '  const ctx = canvas.getContext("2d");\n' +
    '  const overlay = document.getElementById("overlay");\n' +
    '  const startBtn = document.getElementById("start");\n' +
    '  const scoreEl = document.getElementById("score");\n' +
    '  const ammoEl = document.getElementById("ammo");\n' +
    '  const hpEl = document.getElementById("hp");\n' +
    '\n' +
    '  let W = 0, H = 0, running = false, last = 0;\n' +
    '  let score = 0, ammo = 30, hp = 100;\n' +
    '  const keys = Object.create(null);\n' +
    '  let yaw = 0, pitch = 0;\n' +
    '  const player = { x: 0, y: 1.6, z: 8 };\n' +
    '  const enemies = [];\n' +
    '  const bullets = [];\n' +
    '  const sparks = [];\n' +
    '\n' +
    '  function resize() {\n' +
    '    W = canvas.width = window.innerWidth;\n' +
    '    H = canvas.height = window.innerHeight;\n' +
    '  }\n' +
    '  window.addEventListener("resize", resize);\n' +
    '  resize();\n' +
    '\n' +
    '  function spawnEnemy() {\n' +
    '    const a = Math.random() * Math.PI * 2;\n' +
    '    const d = 8 + Math.random() * 14;\n' +
    '    enemies.push({\n' +
    '      x: Math.cos(a) * d,\n' +
    '      y: 1,\n' +
    '      z: Math.sin(a) * d,\n' +
    '      hp: 2 + Math.floor(Math.random() * 2),\n' +
    '      speed: 1.2 + Math.random(),\n' +
    '    });\n' +
    '  }\n' +
    '\n' +
    '  function reset() {\n' +
    '    score = 0; ammo = 30; hp = 100;\n' +
    '    player.x = 0; player.z = 8; yaw = 0; pitch = 0;\n' +
    '    enemies.length = 0; bullets.length = 0; sparks.length = 0;\n' +
    '    for (let i = 0; i < 6; i++) spawnEnemy();\n' +
    '    syncHud();\n' +
    '  }\n' +
    '\n' +
    '  function syncHud() {\n' +
    '    scoreEl.textContent = String(score);\n' +
    '    ammoEl.textContent = String(ammo);\n' +
    '    hpEl.textContent = String(Math.max(0, Math.floor(hp)));\n' +
    '  }\n' +
    '\n' +
    '  function project(x, y, z) {\n' +
    '    const dx = x - player.x, dy = y - player.y, dz = z - player.z;\n' +
    '    const cos = Math.cos(yaw), sin = Math.sin(yaw);\n' +
    '    const rx = dx * cos - dz * sin;\n' +
    '    let rz = dx * sin + dz * cos;\n' +
    '    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);\n' +
    '    const ry = dy * cosP - rz * sinP;\n' +
    '    rz = dy * sinP + rz * cosP;\n' +
    '    if (rz < 0.2) return null;\n' +
    '    const f = (H * 0.9) / rz;\n' +
    '    return { x: W / 2 + rx * f, y: H / 2 - ry * f, s: f, z: rz };\n' +
    '  }\n' +
    '\n' +
    '  function shoot() {\n' +
    '    if (ammo <= 0) return;\n' +
    '    ammo -= 1;\n' +
    '    const dir = {\n' +
    '      x: Math.sin(yaw) * Math.cos(pitch),\n' +
    '      y: Math.sin(pitch),\n' +
    '      z: -Math.cos(yaw) * Math.cos(pitch),\n' +
    '    };\n' +
    '    bullets.push({\n' +
    '      x: player.x, y: player.y, z: player.z,\n' +
    '      vx: dir.x * 42, vy: dir.y * 42, vz: dir.z * 42,\n' +
    '      life: 1.2,\n' +
    '    });\n' +
    '    syncHud();\n' +
    '  }\n' +
    '\n' +
    '  function update(dt) {\n' +
    '    const speed = (keys["Shift"] ? 9 : 5) * dt;\n' +
    '    const forward = { x: Math.sin(yaw), z: -Math.cos(yaw) };\n' +
    '    const right = { x: Math.cos(yaw), z: Math.sin(yaw) };\n' +
    '    if (keys["w"] || keys["ArrowUp"]) { player.x += forward.x * speed; player.z += forward.z * speed; }\n' +
    '    if (keys["s"] || keys["ArrowDown"]) { player.x -= forward.x * speed; player.z -= forward.z * speed; }\n' +
    '    if (keys["a"] || keys["ArrowLeft"]) { player.x -= right.x * speed; player.z -= right.z * speed; }\n' +
    '    if (keys["d"] || keys["ArrowRight"]) { player.x += right.x * speed; player.z += right.z * speed; }\n' +
    '\n' +
    '    for (let i = bullets.length - 1; i >= 0; i--) {\n' +
    '      const b = bullets[i];\n' +
    '      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; b.life -= dt;\n' +
    '      let hit = false;\n' +
    '      for (let j = enemies.length - 1; j >= 0; j--) {\n' +
    '        const e = enemies[j];\n' +
    '        const dx = e.x - b.x, dy = e.y - b.y, dz = e.z - b.z;\n' +
    '        if (dx * dx + dy * dy + dz * dz < 1.1) {\n' +
    '          e.hp -= 1; hit = true;\n' +
    '          sparks.push({ x: e.x, y: e.y, z: e.z, life: 0.35 });\n' +
    '          if (e.hp <= 0) {\n' +
    '            enemies.splice(j, 1);\n' +
    '            score += 10;\n' +
    '            spawnEnemy();\n' +
    '            syncHud();\n' +
    '          }\n' +
    '          break;\n' +
    '        }\n' +
    '      }\n' +
    '      if (hit || b.life <= 0) bullets.splice(i, 1);\n' +
    '    }\n' +
    '\n' +
    '    for (let i = enemies.length - 1; i >= 0; i--) {\n' +
    '      const e = enemies[i];\n' +
    '      const dx = player.x - e.x, dz = player.z - e.z;\n' +
    '      const dist = Math.hypot(dx, dz) || 1;\n' +
    '      e.x += (dx / dist) * e.speed * dt;\n' +
    '      e.z += (dz / dist) * e.speed * dt;\n' +
    '      if (dist < 1.4) {\n' +
    '        hp -= 18 * dt;\n' +
    '        syncHud();\n' +
    '        if (hp <= 0) {\n' +
    '          running = false;\n' +
    '          overlay.classList.remove("hidden");\n' +
    '          overlay.querySelector("h1").textContent = "Mission failed — score " + score;\n' +
    '          document.exitPointerLock && document.exitPointerLock();\n' +
    '        }\n' +
    '      }\n' +
    '    }\n' +
    '\n' +
    '    for (let i = sparks.length - 1; i >= 0; i--) {\n' +
    '      sparks[i].life -= dt;\n' +
    '      if (sparks[i].life <= 0) sparks.splice(i, 1);\n' +
    '    }\n' +
    '  }\n' +
    '\n' +
    '  function drawGround() {\n' +
    '    for (let gz = -20; gz <= 20; gz += 2) {\n' +
    '      for (let gx = -20; gx <= 20; gx += 2) {\n' +
    '        const p = project(gx, 0, gz);\n' +
    '        if (!p) continue;\n' +
    '        const alpha = Math.max(0.05, 1 - p.z / 28);\n' +
    '        ctx.fillStyle = "rgba(60,120,90," + alpha + ")";\n' +
    '        ctx.fillRect(p.x - 1, p.y - 1, 2, 2);\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    '\n' +
    '  function draw() {\n' +
    '    const g = ctx.createLinearGradient(0, 0, 0, H);\n' +
    '    g.addColorStop(0, "#0a1a14");\n' +
    '    g.addColorStop(1, "#030806");\n' +
    '    ctx.fillStyle = g;\n' +
    '    ctx.fillRect(0, 0, W, H);\n' +
    '    drawGround();\n' +
    '\n' +
    '    const drawables = [];\n' +
    '    enemies.forEach(function (e) {\n' +
    '      const p = project(e.x, e.y, e.z);\n' +
    '      if (p) drawables.push({ p: p, kind: "enemy", e: e });\n' +
    '    });\n' +
    '    bullets.forEach(function (b) {\n' +
    '      const p = project(b.x, b.y, b.z);\n' +
    '      if (p) drawables.push({ p: p, kind: "bullet" });\n' +
    '    });\n' +
    '    sparks.forEach(function (s) {\n' +
    '      const p = project(s.x, s.y, s.z);\n' +
    '      if (p) drawables.push({ p: p, kind: "spark", life: s.life });\n' +
    '    });\n' +
    '    drawables.sort(function (a, b) { return b.p.z - a.p.z; });\n' +
    '    drawables.forEach(function (d) {\n' +
    '      if (d.kind === "enemy") {\n' +
    '        const s = Math.max(8, 40 * (d.p.s / 180));\n' +
    '        ctx.fillStyle = "#ff6b4a";\n' +
    '        ctx.beginPath();\n' +
    '        ctx.moveTo(d.p.x, d.p.y - s);\n' +
    '        ctx.lineTo(d.p.x + s * 0.55, d.p.y + s * 0.7);\n' +
    '        ctx.lineTo(d.p.x - s * 0.55, d.p.y + s * 0.7);\n' +
    '        ctx.closePath();\n' +
    '        ctx.fill();\n' +
    '      } else if (d.kind === "bullet") {\n' +
    '        ctx.fillStyle = "#7dffb3";\n' +
    '        ctx.beginPath();\n' +
    '        ctx.arc(d.p.x, d.p.y, 3, 0, Math.PI * 2);\n' +
    '        ctx.fill();\n' +
    '      } else {\n' +
    '        ctx.fillStyle = "rgba(255,200,80," + Math.max(0, d.life * 2) + ")";\n' +
    '        ctx.beginPath();\n' +
    '        ctx.arc(d.p.x, d.p.y, 6, 0, Math.PI * 2);\n' +
    '        ctx.fill();\n' +
    '      }\n' +
    '    });\n' +
    '\n' +
    '    // Crosshair\n' +
    '    ctx.strokeStyle = "rgba(125,255,179,.85)";\n' +
    '    ctx.lineWidth = 1.5;\n' +
    '    ctx.beginPath();\n' +
    '    ctx.moveTo(W / 2 - 10, H / 2); ctx.lineTo(W / 2 + 10, H / 2);\n' +
    '    ctx.moveTo(W / 2, H / 2 - 10); ctx.lineTo(W / 2, H / 2 + 10);\n' +
    '    ctx.stroke();\n' +
    '  }\n' +
    '\n' +
    '  function frame(t) {\n' +
    '    if (!running) return;\n' +
    '    const dt = Math.min(0.05, (t - last) / 1000 || 0.016);\n' +
    '    last = t;\n' +
    '    update(dt);\n' +
    '    draw();\n' +
    '    requestAnimationFrame(frame);\n' +
    '  }\n' +
    '\n' +
    '  window.addEventListener("keydown", function (e) {\n' +
    '    keys[e.key.toLowerCase()] = true;\n' +
    '    keys[e.key] = true;\n' +
    '    if (e.key.toLowerCase() === "r") { ammo = 30; syncHud(); }\n' +
    '  });\n' +
    '  window.addEventListener("keyup", function (e) {\n' +
    '    keys[e.key.toLowerCase()] = false;\n' +
    '    keys[e.key] = false;\n' +
    '  });\n' +
    '  canvas.addEventListener("mousedown", function () {\n' +
    '    if (!running) return;\n' +
    '    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();\n' +
    '    else shoot();\n' +
    '  });\n' +
    '  document.addEventListener("mousemove", function (e) {\n' +
    '    if (document.pointerLockElement !== canvas) return;\n' +
    '    yaw += e.movementX * 0.0022;\n' +
    '    pitch -= e.movementY * 0.0022;\n' +
    '    pitch = Math.max(-1.2, Math.min(1.2, pitch));\n' +
    '  });\n' +
    '\n' +
    '  startBtn.addEventListener("click", function () {\n' +
    '    reset();\n' +
    '    overlay.classList.add("hidden");\n' +
    '    running = true;\n' +
    '    last = performance.now();\n' +
    '    canvas.requestPointerLock();\n' +
    '    requestAnimationFrame(frame);\n' +
    '  });\n' +
    '})();\n'
  );
}

function scaffoldSimpleCanvasJs(title) {
  return (
    '(function () {\n' +
    '  const canvas = document.getElementById("game");\n' +
    '  const ctx = canvas.getContext("2d");\n' +
    '  const overlay = document.getElementById("overlay");\n' +
    '  const startBtn = document.getElementById("start");\n' +
    '  let score = 0, running = false;\n' +
    '  const target = { x: 200, y: 200, r: 24, vx: 120, vy: 90 };\n' +
    '  function resize() {\n' +
    '    canvas.width = window.innerWidth;\n' +
    '    canvas.height = window.innerHeight;\n' +
    '  }\n' +
    '  window.addEventListener("resize", resize);\n' +
    '  resize();\n' +
    '  function loop(t) {\n' +
    '    if (!running) return;\n' +
    '    const w = canvas.width, h = canvas.height;\n' +
    '    ctx.fillStyle = "#06100c";\n' +
    '    ctx.fillRect(0, 0, w, h);\n' +
    '    target.x += target.vx * 0.016; target.y += target.vy * 0.016;\n' +
    '    if (target.x < target.r || target.x > w - target.r) target.vx *= -1;\n' +
    '    if (target.y < target.r || target.y > h - target.r) target.vy *= -1;\n' +
    '    ctx.fillStyle = "#7dffb3";\n' +
    '    ctx.beginPath(); ctx.arc(target.x, target.y, target.r, 0, Math.PI * 2); ctx.fill();\n' +
    '    ctx.fillStyle = "#e8f5ee";\n' +
    '    ctx.font = "16px sans-serif";\n' +
    '    ctx.fillText("' +
    String(title || 'Game').replace(/"/g, '') +
    ' — score " + score, 16, 28);\n' +
    '    requestAnimationFrame(loop);\n' +
    '  }\n' +
    '  canvas.addEventListener("click", function (e) {\n' +
    '    if (!running) return;\n' +
    '    const dx = e.clientX - target.x, dy = e.clientY - target.y;\n' +
    '    if (dx * dx + dy * dy < target.r * target.r) {\n' +
    '      score += 1;\n' +
    '      document.getElementById("score").textContent = String(score);\n' +
    '      target.vx *= 1.05; target.vy *= 1.05;\n' +
    '    }\n' +
    '  });\n' +
    '  startBtn.addEventListener("click", function () {\n' +
    '    overlay.classList.add("hidden");\n' +
    '    running = true;\n' +
    '    requestAnimationFrame(loop);\n' +
    '  });\n' +
    '})();\n'
  );
}

module.exports = {
  shouldBuildFastPath,
  projectSlug,
  extractExplicitProjectPath,
  resolveProjectTarget,
  isMinimalPageRequest,
  isGameLikeRequest,
  isRacingRequest,
  isShooterRequest,
  friendlyProjectTitle,
  constrainFilesToRequest,
  extractFilesFromNarration,
  looksLikeFakeDeliveryClaim,
  buildFilesPrompt,
  parseGeneratedFiles,
  unescapeFileContent,
  unwrapFilesJsonBlob,
  scaffoldHtmlProject,
  scaffoldMinimalHtml,
  scaffoldRacingProject,
};
