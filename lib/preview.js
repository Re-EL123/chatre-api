'use strict';

/**
 * Project preview + static debug for HTML/CSS/JS (and light Node) workspaces.
 * Live iframe serving happens in the client; this module validates and builds
 * the preview payload (localhost URL, port, entry, file map).
 */

function portForRoot(root) {
  const s = String(root || 'project');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 4173 + (h % 800);
}

function listProjectFiles(files, root) {
  const prefix = String(root || '/home/user').replace(/\/$/, '') || '/home/user';
  const out = [];
  Object.keys(files || {}).forEach((p) => {
    const f = files[p];
    if (!f || f.type === 'dir') return;
    if (prefix === '/' || p === prefix || p.indexOf(prefix + '/') === 0) {
      out.push(p);
    }
  });
  return out.sort();
}

function relPath(root, abs) {
  const prefix = String(root || '').replace(/\/$/, '');
  if (abs === prefix) return '';
  if (abs.indexOf(prefix + '/') === 0) return abs.slice(prefix.length + 1);
  return abs.replace(/^\//, '');
}

function findEntry(files, root, paths) {
  const candidates = [
    'index.html',
    'index.htm',
    'public/index.html',
    'src/index.html',
    'app.html',
    'game.html',
  ];
  for (let i = 0; i < candidates.length; i++) {
    const abs = String(root).replace(/\/$/, '') + '/' + candidates[i];
    if (files[abs] && files[abs].type === 'file') return abs;
  }
  const html = paths.filter((p) => /\.html?$/i.test(p));
  return html[0] || null;
}

function syntaxCheckJs(code, path) {
  const errors = [];
  try {
    // Wrap so return/await at top-level don't false-positive as hard failures
    // for classic scripts; still catches most SyntaxErrors.
    // eslint-disable-next-line no-new-func
    new Function(String(code || ''));
  } catch (e) {
    errors.push({
      severity: 'error',
      path: path,
      message: 'JS syntax: ' + (e && e.message ? e.message : String(e)),
    });
  }
  return errors;
}

function extractRefs(html) {
  const src = String(html || '');
  const refs = [];
  const re =
    /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(src))) {
    const u = m[1].trim();
    if (!u || /^https?:\/\//i.test(u) || /^data:/i.test(u) || /^#/.test(u) || /^mailto:/i.test(u)) {
      continue;
    }
    refs.push(u.split('?')[0].split('#')[0]);
  }
  return refs;
}

/**
 * Static end-to-end debug of a project tree.
 */
function debugProject(files, rootPath, opts) {
  const o = opts || {};
  const root =
    String(rootPath || o.root || '/home/user/projects').replace(/\/$/, '') ||
    '/home/user';
  const paths = listProjectFiles(files, root);
  const errors = [];
  const warnings = [];

  if (!paths.length) {
    errors.push({
      severity: 'error',
      path: root,
      message: 'No files under project root',
    });
    return {
      ok: false,
      root,
      entry: null,
      fileCount: 0,
      errors,
      warnings,
      text: 'No files under ' + root,
    };
  }

  const empty = paths.filter(
    (p) => !String((files[p] && files[p].content) || '').trim(),
  );
  empty.forEach((p) => {
    errors.push({
      severity: 'error',
      path: p,
      message: 'Empty file',
    });
  });

  const entry = findEntry(files, root, paths);
  if (!entry && paths.some((p) => /\.(html?|css|js)$/i.test(p))) {
    errors.push({
      severity: 'error',
      path: root,
      message: 'No index.html (or entry HTML) found',
    });
  }

  if (entry) {
    const html = String((files[entry] && files[entry].content) || '');
    if (!/<(?:!doctype\s+html|html[\s>])/i.test(html)) {
      warnings.push({
        severity: 'warning',
        path: entry,
        message: 'HTML may be missing doctype/html root',
      });
    }
    const refs = extractRefs(html);
    refs.forEach((ref) => {
      if (ref.indexOf('..') >= 0) return;
      const abs =
        ref.charAt(0) === '/'
          ? root + ref
          : root + '/' + relPath(root, entry).replace(/[^/]+$/, '') + ref;
      const norm = abs.replace(/\/+/g, '/').replace(/\/\.\//g, '/');
      // Resolve simple ./
      let cleaned = norm;
      while (cleaned.indexOf('/./') >= 0) cleaned = cleaned.replace('/./', '/');
      const candidates = [
        cleaned,
        root + '/' + ref.replace(/^\.\//, ''),
        String(entry).replace(/\/[^/]+$/, '') + '/' + ref.replace(/^\.\//, ''),
      ];
      const hit = candidates.some(
        (c) => files[c] && files[c].type === 'file',
      );
      if (!hit && /\.(css|js|mjs|json|png|jpe?g|gif|svg|webp|wasm)$/i.test(ref)) {
        errors.push({
          severity: 'error',
          path: entry,
          message: 'Missing asset referenced by HTML: ' + ref,
        });
      }
    });
  }

  paths.forEach((p) => {
    if (!/\.(js|mjs|cjs)$/i.test(p)) return;
    const content = String((files[p] && files[p].content) || '');
    if (!content.trim()) return;
    syntaxCheckJs(content, p).forEach((e) => errors.push(e));
  });

  // Inline <script> blocks in HTML
  if (entry) {
    const html = String((files[entry] && files[entry].content) || '');
    const re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    let idx = 0;
    while ((m = re.exec(html))) {
      idx += 1;
      const body = m[1];
      if (!String(body || '').trim()) continue;
      syntaxCheckJs(body, entry + '#inline-script-' + idx).forEach((e) =>
        errors.push(e),
      );
    }
  }

  const ok = errors.length === 0;
  const text = ok
    ? 'Debug pass: ' +
      paths.length +
      ' files' +
      (entry ? '; entry ' + entry : '') +
      (warnings.length ? '; ' + warnings.length + ' warning(s)' : '')
    : 'Debug found ' +
      errors.length +
      ' error(s):\n' +
      errors
        .slice(0, 12)
        .map((e) => '- [' + (e.path || '?') + '] ' + e.message)
        .join('\n');

  return {
    ok,
    root,
    entry,
    fileCount: paths.length,
    errors,
    warnings,
    text,
  };
}

/**
 * Build a client preview payload (files keyed by relative path).
 */
function buildPreviewPayload(files, rootPath, debug) {
  const root = String(rootPath || (debug && debug.root) || '').replace(/\/$/, '');
  const paths = listProjectFiles(files, root);
  const port = portForRoot(root);
  const entryAbs = (debug && debug.entry) || findEntry(files, root, paths);
  const entryRel = entryAbs ? relPath(root, entryAbs) || 'index.html' : 'index.html';
  const map = {};
  paths.forEach((p) => {
    const rel = relPath(root, p) || p.split('/').pop();
    const f = files[p];
    map[rel] = {
      content: f && f.content != null ? String(f.content) : '',
      encoding: (f && f.encoding) || 'utf8',
      mime: guessMime(rel),
    };
  });
  return {
    root,
    port,
    url: 'http://localhost:' + port + '/' + entryRel.replace(/^\//, ''),
    origin: 'http://localhost:' + port,
    entry: entryRel,
    entryAbs: entryAbs,
    files: map,
    fileCount: paths.length,
  };
}

function guessMime(path) {
  if (/\.html?$/i.test(path)) return 'text/html; charset=utf-8';
  if (/\.css$/i.test(path)) return 'text/css; charset=utf-8';
  if (/\.js$/i.test(path) || /\.mjs$/i.test(path)) {
    return 'text/javascript; charset=utf-8';
  }
  if (/\.json$/i.test(path)) return 'application/json';
  if (/\.svg$/i.test(path)) return 'image/svg+xml';
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.gif$/i.test(path)) return 'image/gif';
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.md$/i.test(path)) return 'text/markdown; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function runPreviewProject(ctx, params) {
  const p = params || {};
  const slug =
    p.slug ||
    (ctx && ctx.activeProject) ||
    null;
  let root = p.path || p.root || null;
  if (!root && slug) root = '/home/user/projects/' + slug;
  if (!root) root = (ctx && ctx.cwd) || '/home/user';
  root = String(root).replace(/\/$/, '');

  const files = (ctx && ctx.files) || {};
  const debug = debugProject(files, root);
  const preview = buildPreviewPayload(files, root, debug);

  // Preview must use the same post-write map bytes as tools.
  // Never report live preview OK when entry is missing/empty.
  const entryAbs = preview.entryAbs || debug.entry;
  const entryFile = entryAbs ? files[entryAbs] : null;
  const entryContent =
    entryFile && entryFile.type === 'file'
      ? String(entryFile.content || '')
      : '';
  const entryEmpty = !entryAbs || !entryContent.trim();
  if (entryEmpty) {
    const msg = !entryAbs
      ? 'No entry HTML in project map — cannot open live preview'
      : 'Entry file is empty in workspace map — refusing live preview: ' + entryAbs;
    if (!debug.errors.some((e) => e.message && e.message.indexOf('Empty') >= 0)) {
      debug.errors.push({
        severity: 'error',
        path: entryAbs || root,
        message: msg,
      });
    }
    debug.ok = false;
    debug.text =
      'Preview blocked: ' +
      msg +
      (debug.errors.length
        ? '\n' +
          debug.errors
            .slice(0, 8)
            .map((e) => '- [' + (e.path || '?') + '] ' + e.message)
            .join('\n')
        : '');
  }

  const ok = !!debug.ok && !entryEmpty;
  return {
    ok,
    tool: 'preview_project',
    path: root,
    entry: debug.entry,
    fileCount: debug.fileCount,
    errors: debug.errors,
    warnings: debug.warnings,
    preview: ok ? preview : Object.assign({}, preview, { blocked: true }),
    localhost: ok ? preview.url : null,
    port: preview.port,
    revision: ctx && ctx.revision != null ? ctx.revision : undefined,
    text:
      debug.text +
      (ok
        ? '\nLive preview: ' + preview.url
        : '\nFix errors, then re-run preview_project. Do not claim done yet.'),
  };
}

module.exports = {
  portForRoot,
  listProjectFiles,
  debugProject,
  buildPreviewPayload,
  runPreviewProject,
  guessMime,
};
