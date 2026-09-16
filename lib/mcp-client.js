'use strict';

/**
 * MCP client for the API agent — mirrors chatre1/public/mcp.js + Worker /api/mcp relay.
 * Connections persist per user (Firestore secrets/mcp or memory). No new Vercel route:
 * tools run inside executeRemoteTool; connect/list via /api/me?action=mcp.
 */

const { encrypt, decrypt, encryptionConfigured } = require('./crypto-secrets');
const users = require('./users');

const REGISTRY = [
  {
    uuid: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, repos, search code',
    keywords: ['github', 'repo', 'pull request', 'issue', 'code'],
    endpoint: 'https://api.github.com',
  },
  {
    uuid: 'notion',
    name: 'Notion',
    description: 'Pages, databases, search, task lists',
    keywords: ['notion', 'page', 'database', 'wiki', 'task'],
    endpoint: 'https://api.notion.com',
  },
  {
    uuid: 'slack',
    name: 'Slack',
    description: 'Channels, messages, search, threads',
    keywords: ['slack', 'channel', 'message', 'dm', 'thread'],
    endpoint: 'https://slack.com/api',
  },
  {
    uuid: 'jira',
    name: 'Jira',
    description: 'Projects, issues, sprints, boards',
    keywords: ['jira', 'issue', 'sprint', 'board', 'ticket', 'atlassian'],
    endpoint: 'https://your-domain.atlassian.net/rest/api/3',
  },
  {
    uuid: 'linear',
    name: 'Linear',
    description: 'Issues, projects, cycles, teams',
    keywords: ['linear', 'issue', 'project', 'cycle', 'team'],
    endpoint: 'https://api.linear.app/graphql',
  },
  {
    uuid: 'asana',
    name: 'Asana',
    description: 'Tasks, projects, workspaces, sections',
    keywords: ['asana', 'task', 'project', 'workspace'],
    endpoint: 'https://app.asana.com/api/1.0',
  },
  {
    uuid: 'google_drive',
    name: 'Google Drive',
    description: 'Files, folders, search, documents',
    keywords: ['google drive', 'drive', 'file', 'document', 'gdrive'],
    endpoint: 'https://www.googleapis.com/drive/v3',
  },
  {
    uuid: 'trello',
    name: 'Trello',
    description: 'Boards, cards, lists, checklists',
    keywords: ['trello', 'board', 'card', 'list'],
    endpoint: 'https://api.trello.com/1',
  },
  {
    uuid: 'gitlab',
    name: 'GitLab',
    description: 'Repos, issues, merge requests, pipelines',
    keywords: ['gitlab', 'repo', 'merge request', 'pipeline', 'ci'],
    endpoint: 'https://gitlab.com/api/v4',
  },
  {
    uuid: 'airtable',
    name: 'Airtable',
    description: 'Bases, tables, records, views',
    keywords: ['airtable', 'base', 'table', 'record', 'database'],
    endpoint: 'https://api.airtable.com/v0',
  },
  {
    uuid: 'figma',
    name: 'Figma',
    description: 'Files, components, comments, design tokens',
    keywords: ['figma', 'design', 'component', 'file'],
    endpoint: 'https://api.figma.com/v1',
  },
  {
    uuid: 'calendly',
    name: 'Calendly',
    description: 'Events, scheduling, availability',
    keywords: ['calendly', 'schedule', 'event', 'meeting', 'calendar'],
    endpoint: 'https://api.calendly.com',
  },
];

function findRegistry(uuid) {
  const id = String(uuid || '').toLowerCase().trim();
  return REGISTRY.find((r) => r.uuid === id) || null;
}

function toSummary(r, connectedIds) {
  const set = connectedIds instanceof Set ? connectedIds : new Set(connectedIds || []);
  return {
    uuid: r.uuid,
    name: r.name,
    description: r.description,
    connected: set.has(r.uuid),
  };
}

function searchRegistry(query, connectedIds) {
  const q = String(query || '')
    .toLowerCase()
    .trim();
  if (!q) return REGISTRY.map((r) => toSummary(r, connectedIds));
  const terms = q.split(/[\s,]+/).filter(Boolean);
  const scored = REGISTRY.map((r) => {
    let score = 0;
    const hay = (r.name + ' ' + r.description + ' ' + r.keywords.join(' ')).toLowerCase();
    terms.forEach((t) => {
      if (hay.indexOf(t) !== -1) score += 1;
      if (r.name.toLowerCase().indexOf(t) !== -1) score += 2;
      if (r.keywords.indexOf(t) !== -1) score += 3;
    });
    return { reg: r, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => toSummary(s.reg, connectedIds));
}

/**
 * JSON-RPC MCP relay (HTTPS only). Mirrors Worker handleMcpRequest.
 */
async function mcpJsonRpc(opts) {
  const o = opts || {};
  const endpoint = String(o.endpoint || '').trim();
  if (!/^https:\/\//i.test(endpoint)) {
    return { ok: false, error: 'endpoint must be an https URL' };
  }
  let host = '';
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return { ok: false, error: 'invalid endpoint URL' };
  }
  // Block obvious SSRF to link-local / metadata
  if (
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|metadata\.google)$/i.test(host) ||
    host === '::1'
  ) {
    return { ok: false, error: 'endpoint host not allowed' };
  }

  const method = o.method === 'tools/list' ? 'tools/list' : 'tools/call';
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params:
      method === 'tools/list'
        ? {}
        : { name: o.tool, arguments: o.arguments || {} },
  };

  const forwardHeaders = Object.assign({}, o.headers || {});
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: Object.assign(
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': 'Chatre/1.0',
      },
      forwardHeaders,
    ),
    body: JSON.stringify(payload),
  });

  const ct = upstream.headers.get('content-type') || '';
  let result = null;
  if (ct.includes('text/event-stream')) {
    const raw = await upstream.text();
    for (const line of raw.split('\n')) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m && m[1]) {
        try {
          result = JSON.parse(m[1]);
        } catch {
          /* keep last */
        }
      }
    }
  } else {
    try {
      result = await upstream.json();
    } catch {
      result = { ok: false, error: 'Non-JSON response from ' + endpoint };
    }
  }

  if (!upstream.ok && !result) {
    return { ok: false, error: 'Upstream returned ' + upstream.status };
  }

  const envelope = result || {};
  if (envelope.error) {
    return {
      ok: false,
      error:
        typeof envelope.error === 'string'
          ? envelope.error
          : JSON.stringify(envelope.error),
    };
  }
  return { ok: true, result: envelope.result != null ? envelope.result : envelope };
}

async function listConnections(uid) {
  const doc = await users.getMcpDoc(uid);
  const out = [];
  Object.keys(doc || {}).forEach((uuid) => {
    if (uuid === 'updatedAt') return;
    const entry = doc[uuid];
    if (!entry || typeof entry !== 'object') return;
    out.push({
      uuid,
      name: entry.name || uuid,
      endpoint: entry.endpoint || null,
      connectedAt: entry.connectedAt || null,
      hasAuth: !!(entry.auth && entry.auth.ciphertext),
    });
  });
  return out;
}

async function connect(uid, uuid, opts) {
  const o = opts || {};
  const reg = findRegistry(uuid);
  const id = String(uuid || '')
    .toLowerCase()
    .trim();
  if (!id) return { ok: false, error: 'uuid required' };

  let endpoint = String(o.endpoint || (reg && reg.endpoint) || '').trim();
  if (!endpoint && !reg) {
    return { ok: false, error: 'Unknown MCP connector: ' + uuid };
  }
  if (!/^https:\/\//i.test(endpoint)) {
    return { ok: false, error: 'endpoint must be an https URL' };
  }

  const entry = {
    name: (reg && reg.name) || o.name || id,
    endpoint,
    connectedAt: new Date().toISOString(),
    tools: Array.isArray(o.tools) ? o.tools : [],
  };

  const token = o.token || o.apiKey || o.authorization || '';
  if (token) {
    if (!encryptionConfigured()) {
      return {
        ok: false,
        error: 'Server encryption not configured — cannot store MCP auth',
      };
    }
    entry.auth = encrypt(String(token));
    entry.authHeader = o.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization';
  }

  await users.setMcpConnection(uid, id, entry);
  return {
    ok: true,
    uuid: id,
    name: entry.name,
    endpoint: entry.endpoint,
    connectedAt: entry.connectedAt,
  };
}

async function disconnect(uid, uuid) {
  const id = String(uuid || '')
    .toLowerCase()
    .trim();
  await users.deleteMcpConnection(uid, id);
  return { ok: true, uuid: id };
}

async function getConnection(uid, uuid) {
  const doc = await users.getMcpDoc(uid);
  const id = String(uuid || '')
    .toLowerCase()
    .trim();
  const entry = doc && doc[id];
  if (!entry) return null;
  let headers = {};
  if (entry.auth && entry.auth.ciphertext) {
    try {
      const token = decrypt(entry.auth);
      const header = entry.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization';
      headers[header] =
        header === 'authorization' && !/^Bearer\s/i.test(token)
          ? 'Bearer ' + token
          : token;
    } catch {
      /* ignore bad blob */
    }
  }
  return {
    uuid: id,
    name: entry.name,
    endpoint: entry.endpoint,
    tools: entry.tools || [],
    headers,
  };
}

async function callMcp(uid, server, tool, args, extraHeaders) {
  const conn = await getConnection(uid, server);
  if (!conn) {
    return {
      ok: false,
      error:
        'Not connected to ' +
        server +
        '. Call suggest_connectors / connect via Settings, or /api/me?action=mcp.',
    };
  }
  if (!tool) return { ok: false, error: 'tool name required' };
  return mcpJsonRpc({
    endpoint: conn.endpoint,
    method: 'tools/call',
    tool,
    arguments: args || {},
    headers: Object.assign({}, conn.headers, extraHeaders || {}),
  });
}

async function listMcpTools(uid, server) {
  const conn = await getConnection(uid, server);
  if (!conn) {
    return { ok: false, error: 'Not connected to ' + server };
  }
  const res = await mcpJsonRpc({
    endpoint: conn.endpoint,
    method: 'tools/list',
    headers: conn.headers,
  });
  if (!res.ok) {
    return {
      ok: true,
      tools: conn.tools || [],
      note: res.error || 'Could not discover tools from ' + server,
    };
  }
  const tools =
    (res.result && res.result.tools) ||
    (Array.isArray(res.result) ? res.result : []);
  // Cache discovered tools (no secrets)
  try {
    const doc = await users.getMcpDoc(uid);
    const entry = doc && doc[server];
    if (entry) {
      entry.tools = tools;
      await users.setMcpConnection(uid, server, entry);
    }
  } catch {
    /* ignore */
  }
  return { ok: true, tools };
}

module.exports = {
  REGISTRY,
  findRegistry,
  searchRegistry,
  mcpJsonRpc,
  listConnections,
  connect,
  disconnect,
  getConnection,
  callMcp,
  listMcpTools,
};
