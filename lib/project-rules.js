'use strict';

/**
 * Modular project instruction rules — Cursor-style .mdc / .chatre/rules packs.
 *
 * Scanned locations (workspace virtual FS):
 *   /.chatre/rules/*.{md,mdc}
 *   /.cursor/rules/*.{md,mdc}
 *   /home/user/projects/<slug>/.chatre/rules/*.{md,mdc}
 *   /home/user/projects/<slug>/.cursor/rules/*.{md,mdc}
 *
 * Frontmatter:
 * ---
 * description: When editing DB schemas
 * globs: src/db/** , prisma/schema.prisma
 * alwaysApply: false
 * ---
 * # Instructions...
 */

function parseFrontmatter(raw) {
  const src = String(raw || '');
  if (!src.startsWith('---')) {
    return { meta: {}, body: src.trim() };
  }
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: src.trim() };
  const fm = src.slice(3, end).trim();
  const body = src.slice(end + 4).replace(/^\s*\n/, '').trim();
  const meta = {};
  fm.split('\n').forEach(function (line) {
    const m = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (!m) return;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (/^(true|false)$/i.test(val)) {
      meta[key] = /^true$/i.test(val);
    } else {
      meta[key] = val;
    }
  });
  return { meta: meta, body: body };
}

function globToRegExp(glob) {
  const g = String(glob || '').trim();
  if (!g || g === '*' || g === '**') return /.*/;
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      out += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

function parseGlobs(val) {
  if (Array.isArray(val)) return val.map(String).filter(Boolean);
  return String(val || '')
    .split(/[,;\n]/)
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

function matchGlob(path, glob) {
  const p = String(path || '');
  const g = String(glob || '').trim().replace(/^\.\//, '');
  if (!g) return false;
  const re = globToRegExp(g);
  if (re.test(p)) return true;
  const base = p.split('/').pop();
  if (base && re.test(base)) return true;
  // Match relative to project root or any path suffix (src/db/** vs /home/.../src/db/x.js)
  const parts = p.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    if (re.test(suffix)) return true;
  }
  if (g.startsWith('**/')) {
    const rest = g.slice(3);
    const re2 = globToRegExp(rest);
    return (
      re2.test(p) ||
      parts.some(function (_, i) {
        return re2.test(parts.slice(i).join('/'));
      })
    );
  }
  return false;
}

function ruleMatchesPath(rule, filePath) {
  if (!rule) return false;
  if (rule.alwaysApply) return true;
  const globs = rule.globs || [];
  if (!globs.length) return false;
  return globs.some(function (g) {
    return matchGlob(filePath, g);
  });
}

function isRulesPath(path) {
  return /\/(?:\.chatre|\.cursor)\/rules\/[^/]+\.(?:md|mdc)$/i.test(
    String(path || ''),
  );
}

function collectRuleFiles(files) {
  const map = files || {};
  const paths = Object.keys(map).filter(function (p) {
    const f = map[p];
    return f && f.type !== 'dir' && isRulesPath(p);
  });
  paths.sort();
  return paths.map(function (p) {
    const parsed = parseFrontmatter(map[p].content || '');
    return {
      path: p,
      description: parsed.meta.description || '',
      globs: parseGlobs(parsed.meta.globs || parsed.meta.glob || ''),
      alwaysApply: !!parsed.meta.alwaysApply,
      body: parsed.body,
    };
  });
}

/**
 * Rules that apply to a workspace path (for read/write injection).
 */
function matchingRules(files, filePath) {
  return collectRuleFiles(files).filter(function (r) {
    return r.body && ruleMatchesPath(r, filePath);
  });
}

/**
 * Always-apply rules + rules matching any of the given paths.
 */
function rulesForPaths(files, paths) {
  const list = collectRuleFiles(files);
  const want = new Set();
  const out = [];
  list.forEach(function (r) {
    if (!r.body) return;
    if (r.alwaysApply) {
      if (!want.has(r.path)) {
        want.add(r.path);
        out.push(r);
      }
      return;
    }
    const hits = (paths || []).some(function (p) {
      return ruleMatchesPath(r, p);
    });
    if (hits && !want.has(r.path)) {
      want.add(r.path);
      out.push(r);
    }
  });
  return out;
}

function formatRulesReminder(rules) {
  const list = Array.isArray(rules) ? rules : [];
  if (!list.length) return '';
  let text = '<system-reminder>\nProject rules (follow for this path):\n';
  list.forEach(function (r) {
    text +=
      '\n### ' +
      (r.description || r.path) +
      ' (' +
      r.path +
      ')\n' +
      r.body +
      '\n';
  });
  text += '</system-reminder>';
  return text;
}

module.exports = {
  parseFrontmatter,
  parseGlobs,
  matchGlob,
  collectRuleFiles,
  matchingRules,
  rulesForPaths,
  formatRulesReminder,
  isRulesPath,
};
