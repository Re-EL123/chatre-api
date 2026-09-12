'use strict';

/**
 * Project awareness — registry under /home/user/projects/<slug>/
 * with durable AGENTS.md so agents never lose the active project.
 */

const PROJECTS_ROOT = '/home/user/projects';

function agentsMdTemplate({ slug, goal, stack }) {
  const name = String(slug || 'project');
  const purpose = String(goal || '').trim() || 'User project in the Chatre workspace.';
  const stackLine = String(stack || '').trim();
  return (
    '# AGENTS.md — ' +
    name +
    '\n\n' +
    '> Persistent project brief for Chatre agents. Read this before editing.\n\n' +
    '## Project\n' +
    '- **Root:** `' +
    PROJECTS_ROOT +
    '/' +
    name +
    '`\n' +
    '- **Purpose:** ' +
    purpose +
    '\n' +
    (stackLine ? '- **Stack:** ' + stackLine + '\n' : '') +
    '\n' +
    '## Conventions\n' +
    '- All new files go under this root unless the user asks otherwise.\n' +
    '- Prefer `write_file` / `patch_file` / `apply_patch`; never claim files exist without tool results.\n' +
    '- Use `execute_command`, `run_javascript`, `run_python` from this root (`cwd`).\n' +
    '- Update this file when goals, layout, or commands change.\n\n' +
    '## Structure\n' +
    '_(Agent: keep a short tree of important paths here.)_\n\n' +
    '## Commands\n' +
    '- Install / build / test: _(fill in)_\n\n' +
    '## Notes\n' +
    '- Created by Chatre project awareness.\n'
  );
}

function slugFromPath(path) {
  const m = String(path || '').match(/^\/home\/user\/projects\/([^/]+)/);
  return m ? m[1] : null;
}

function projectRoot(slug) {
  return PROJECTS_ROOT + '/' + String(slug || '').replace(/^\/+|\/+$/g, '');
}

function isUnderProjects(path) {
  return String(path || '').indexOf(PROJECTS_ROOT + '/') === 0;
}

/**
 * Scan workspace files map → project registry entries.
 */
function detectProjects(files) {
  const map = files || {};
  const projects = {};
  Object.keys(map).forEach((p) => {
    const slug = slugFromPath(p);
    if (!slug || slug === '.' || slug === '..') return;
    if (!projects[slug]) {
      const root = projectRoot(slug);
      const agentsPath = root + '/AGENTS.md';
      projects[slug] = {
        slug,
        root,
        agentsMd: agentsPath,
        hasAgentsMd: !!(map[agentsPath] && map[agentsPath].type === 'file'),
        fileCount: 0,
        lastActiveAt: null,
      };
    }
    if (map[p] && map[p].type === 'file') {
      projects[slug].fileCount += 1;
      if (p.endsWith('/AGENTS.md')) projects[slug].hasAgentsMd = true;
    }
  });
  return projects;
}

function readAgentsMd(files, slug) {
  const path = projectRoot(slug) + '/AGENTS.md';
  const f = files && files[path];
  if (!f || f.type !== 'file') return null;
  return String(f.content || '');
}

/**
 * Ensure project dir + AGENTS.md exist in ctx.files (caller persists).
 * Returns { slug, root, agentsMd, created, agentsCreated }.
 */
function ensureProject(ctx, slug, opts) {
  const o = opts || {};
  const name =
    String(slug || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project';
  const root = projectRoot(name);
  const agentsPath = root + '/AGENTS.md';
  ctx.files = ctx.files || {};
  ctx.projects = ctx.projects || detectProjects(ctx.files);

  let created = false;
  let agentsCreated = false;

  if (!ctx.files[PROJECTS_ROOT] || ctx.files[PROJECTS_ROOT].type !== 'dir') {
    ctx.files[PROJECTS_ROOT] = {
      path: PROJECTS_ROOT,
      type: 'dir',
      children: [],
    };
  }

  if (!ctx.files[root] || ctx.files[root].type !== 'dir') {
    ctx.files[root] = { path: root, type: 'dir', children: [] };
    created = true;
  }

  const parent = ctx.files[PROJECTS_ROOT];
  if (parent && Array.isArray(parent.children) && parent.children.indexOf(name) < 0) {
    parent.children = parent.children.concat([name]);
  }

  if (
    o.forceAgentsMd ||
    !ctx.files[agentsPath] ||
    ctx.files[agentsPath].type !== 'file' ||
    !String(ctx.files[agentsPath].content || '').trim()
  ) {
    if (!ctx.files[agentsPath] || !String((ctx.files[agentsPath] && ctx.files[agentsPath].content) || '').trim()) {
      ctx.files[agentsPath] = {
        path: agentsPath,
        type: 'file',
        content: agentsMdTemplate({
          slug: name,
          goal: o.goal || (ctx.briefing && ctx.briefing.goal) || '',
          stack: o.stack || '',
        }),
      };
      agentsCreated = true;
    }
  }

  const entry = Object.assign({}, ctx.projects[name] || {}, {
    slug: name,
    root,
    agentsMd: agentsPath,
    hasAgentsMd: true,
    lastActiveAt: new Date().toISOString(),
    goal: o.goal || (ctx.projects[name] && ctx.projects[name].goal) || '',
  });
  ctx.projects[name] = entry;
  ctx.activeProject = name;
  if (o.setCwd !== false) {
    ctx.cwd = root;
  }

  return {
    slug: name,
    root,
    agentsMd: agentsPath,
    created,
    agentsCreated,
    entry,
  };
}

/**
 * If a write lands under projects/, ensure registry + AGENTS.md.
 */
function noteProjectWrite(ctx, filePath, opts) {
  const slug = slugFromPath(filePath);
  if (!slug) return null;
  return ensureProject(ctx, slug, opts || {});
}

/**
 * Text block injected into the agent every turn.
 */
function projectContextBlock(ctx, opts) {
  const o = opts || {};
  const files = (ctx && ctx.files) || {};
  const projects = Object.assign(
    {},
    detectProjects(files),
  );
  // Enrich with registry metadata only for projects that exist on disk
  Object.keys((ctx && ctx.projects) || {}).forEach((slug) => {
    if (projects[slug]) {
      projects[slug] = Object.assign({}, ctx.projects[slug], projects[slug]);
    }
  });
  const slugs = Object.keys(projects).sort();
  const active =
    ((ctx && ctx.activeProject) && projects[ctx.activeProject]
      ? ctx.activeProject
      : null) ||
    o.activeProject ||
    (slugs.length === 1 ? slugs[0] : null);

  const lines = [
    '# Active project (do not forget)',
  ];
  if (!slugs.length) {
    lines.push(
      'No projects yet. On create/build/repo tasks, write under ' +
        PROJECTS_ROOT +
        '/<slug>/ and keep AGENTS.md updated.',
    );
    return { text: lines.join('\n'), active: null, projects };
  }

  lines.push(
    'Known projects: ' +
      slugs
        .map((s) => {
          const p = projects[s];
          return (
            s +
            (p && p.hasAgentsMd ? ' (AGENTS.md)' : '') +
            (p && p.fileCount ? ' · ' + p.fileCount + ' files' : '')
          );
        })
        .join(', '),
  );

  if (active && projects[active]) {
    const root = projects[active].root || projectRoot(active);
    lines.push('**Active project:** `' + root + '`');
    lines.push('Prefer all writes, patches, and shell cwd under this root.');
    const md = readAgentsMd(files, active);
    if (md) {
      lines.push('## AGENTS.md (active — follow this)');
      lines.push(md.slice(0, o.agentsLimit || 3500));
    } else {
      lines.push(
        'AGENTS.md missing — create `' +
          root +
          '/AGENTS.md` on the next write.',
      );
    }
  } else {
    lines.push(
      'No active project selected. If the user names one, set cwd and use that root; otherwise create ' +
        PROJECTS_ROOT +
        '/<slug>/.',
    );
  }

  return { text: lines.join('\n'), active, projects };
}

/**
 * Build nested tree nodes from flat files map for IDE UI.
 * Returns [{ name, path, type: 'dir'|'file', children? }]
 */
function buildFileTree(files, rootPath) {
  const map = files || {};
  const root = rootPath || '/home/user';
  const nodes = {};

  function ensureDir(path) {
    if (nodes[path]) return nodes[path];
    const parts = path.split('/').filter(Boolean);
    const name = parts.length ? parts[parts.length - 1] : '/';
    nodes[path] = { name: name || '/', path, type: 'dir', children: [] };
    return nodes[path];
  }

  ensureDir(root);

  Object.keys(map)
    .sort()
    .forEach((p) => {
      if (!p || p === root) return;
      if (root !== '/' && p.indexOf(root + '/') !== 0 && p !== root) return;
      const entry = map[p];
      if (!entry) return;
      if (entry.type === 'dir') {
        ensureDir(p);
        return;
      }
      if (entry.type !== 'file') return;
      const parts = p.split('/').filter(Boolean);
      let cur = '';
      for (let i = 0; i < parts.length - 1; i++) {
        const parent = cur || '';
        cur = cur + '/' + parts[i];
        ensureDir(cur);
        const parentNode = ensureDir(parent || '/');
        if (
          parentNode.children.indexOf(cur) < 0 &&
          !parentNode.children.some((c) => c === cur || (c && c.path === cur))
        ) {
          /* children filled later */
        }
      }
      nodes[p] = {
        name: parts[parts.length - 1],
        path: p,
        type: 'file',
      };
    });

  // Link children
  Object.keys(nodes).forEach((p) => {
    const node = nodes[p];
    if (node.type !== 'dir') return;
    node.children = [];
  });
  Object.keys(nodes).forEach((p) => {
    if (p === root || p === '/') return;
    const parent =
      p.replace(/\/[^/]+$/, '') || '/';
    if (!nodes[parent]) ensureDir(parent);
    if (nodes[parent] && nodes[parent].type === 'dir') {
      nodes[parent].children.push(nodes[p]);
    }
  });
  Object.keys(nodes).forEach((p) => {
    if (nodes[p].type === 'dir') {
      nodes[p].children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
      });
    }
  });

  return nodes[root] || ensureDir(root);
}

module.exports = {
  PROJECTS_ROOT,
  agentsMdTemplate,
  slugFromPath,
  projectRoot,
  isUnderProjects,
  detectProjects,
  readAgentsMd,
  ensureProject,
  noteProjectWrite,
  projectContextBlock,
  buildFileTree,
};
