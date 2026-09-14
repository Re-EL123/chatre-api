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

function scaffoldHtmlProject(slug, userMessage, goal) {
  const name = String(slug || 'project');
  const title = String(goal || userMessage || 'Ops Game')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Ops Game';
  const blob = title + ' ' + String(userMessage || '');
  if (/\bcalculator\b/i.test(blob)) {
    return scaffoldCalculatorProject(name, title);
  }
  const isShooter = /\b(shoot|ops|fps|3d|arena|combat|gun)\b/i.test(blob);

  const indexHtml =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="UTF-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '  <title>' +
    title.replace(/</g, '') +
    '</title>\n' +
    '  <link rel="stylesheet" href="style.css" />\n' +
    '</head>\n<body>\n' +
    '  <div id="hud">\n' +
    '    <div class="brand">' +
    title.replace(/</g, '') +
    '</div>\n' +
    '    <div class="stats">Score <span id="score">0</span> · Ammo <span id="ammo">30</span> · HP <span id="hp">100</span></div>\n' +
    '  </div>\n' +
    '  <canvas id="game"></canvas>\n' +
    '  <div id="overlay">\n' +
    '    <h1>' +
    title.replace(/</g, '') +
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

  const gameJs = isShooter
    ? scaffoldOpsShooterJs()
    : scaffoldSimpleCanvasJs(title);

  return {
    slug: name,
    files: [
      { relativePath: 'index.html', content: indexHtml },
      { relativePath: 'style.css', content: styleCss },
      { relativePath: 'game.js', content: gameJs },
      {
        relativePath: 'README.md',
        content:
          '# ' +
          title +
          '\n\nOpen `index.html` in a browser.\n\nControls: WASD, mouse look, click to shoot, R reload.\n',
      },
    ],
  };
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
  extractFilesFromNarration,
  looksLikeFakeDeliveryClaim,
  buildFilesPrompt,
  parseGeneratedFiles,
  scaffoldHtmlProject,
};
