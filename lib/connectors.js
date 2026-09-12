'use strict';

/**
 * User-owned app connectors (GitHub, Vercel, Supabase, Firebase).
 * Tokens encrypted at rest like BYOK — never returned to the client.
 */

const { decrypt } = require('./crypto-secrets');
const users = require('./users');

const CONNECTOR_PROVIDERS = ['github', 'vercel', 'supabase', 'firebase'];

const HOST_ALLOWLIST = {
  github: [/^api\.github\.com$/i],
  vercel: [/^api\.vercel\.com$/i],
  supabase: [
    /^api\.supabase\.com$/i,
    /^[a-z0-9-]+\.supabase\.co$/i,
  ],
  firebase: [
    /^identitytoolkit\.googleapis\.com$/i,
    /^firebase\.googleapis\.com$/i,
    /^firestore\.googleapis\.com$/i,
    /^[a-z0-9-]+\.firebaseio\.com$/i,
  ],
};

function normalizeToken(raw) {
  return String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, '')
    .trim();
}

function validateConnectorToken(provider, token, meta) {
  const t = normalizeToken(token);
  const p = String(provider || '').toLowerCase();
  if (!CONNECTOR_PROVIDERS.includes(p)) {
    return { ok: false, error: 'Unknown connector: ' + provider };
  }
  if (!t || t.length < 8) {
    return { ok: false, error: 'Token looks empty or too short' };
  }
  if (p === 'github' && !/^(gh[pousr]_|github_pat_|gho_|ghu_|ghs_|ghr_)/i.test(t) && t.length < 20) {
    return { ok: false, error: 'GitHub token should be a PAT (ghp_… / github_pat_…) or OAuth token' };
  }
  if (p === 'vercel' && !/^vercel_/i.test(t) && t.length < 20) {
    return {
      ok: false,
      error: 'Paste a Vercel token from https://vercel.com/account/tokens',
    };
  }
  if (p === 'supabase') {
    const url = meta && (meta.projectUrl || meta.url);
    if (!url && !/^sb[a-z]_/i.test(t) && t.length < 20) {
      return {
        ok: false,
        error: 'Supabase needs a service_role/anon key; optionally set project URL in meta',
      };
    }
  }
  if (p === 'firebase') {
    // Accept web API key or service-account JSON string
    if (t.charAt(0) === '{') {
      try {
        const j = JSON.parse(String(token).trim());
        if (!j.private_key && !j.apiKey && !j.project_id) {
          return { ok: false, error: 'Firebase JSON needs private_key or apiKey + project_id' };
        }
      } catch {
        return { ok: false, error: 'Firebase token JSON is invalid' };
      }
    } else if (t.length < 20) {
      return { ok: false, error: 'Firebase web API key or service-account JSON required' };
    }
  }
  return { ok: true, token: t.charAt(0) === '{' ? String(token).trim() : t };
}

function hostAllowed(provider, hostname) {
  const rules = HOST_ALLOWLIST[provider] || [];
  return rules.some((re) => re.test(String(hostname || '')));
}

async function getDecryptedToken(uid, provider) {
  const doc = await users.getConnectorsDoc(uid);
  const blob = doc && doc[provider];
  if (!blob || !blob.ciphertext) {
    return { ok: false, error: 'No ' + provider + ' connector saved. Settings → Integrations.' };
  }
  try {
    const token = decrypt(blob);
    return {
      ok: true,
      token,
      meta: blob.meta || {},
      kind: (blob.meta && blob.meta.kind) || 'token',
    };
  } catch (err) {
    return { ok: false, error: 'Could not decrypt connector: ' + (err.message || err) };
  }
}

async function testConnector(uid, provider, overrideToken, overrideMeta) {
  const p = String(provider || '').toLowerCase();
  if (!CONNECTOR_PROVIDERS.includes(p)) {
    return { ok: false, error: 'Unknown provider' };
  }
  let token = overrideToken;
  let meta = overrideMeta || {};
  if (!token) {
    const got = await getDecryptedToken(uid, p);
    if (!got.ok) return got;
    token = got.token;
    meta = Object.assign({}, got.meta, meta);
  } else {
    const checked = validateConnectorToken(p, token, meta);
    if (!checked.ok) return checked;
    token = checked.token;
  }

  try {
    if (p === 'github') {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Chatre',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: (data && data.message) || 'GitHub auth failed (' + res.status + ')',
        };
      }
      return {
        ok: true,
        provider: p,
        login: data.login,
        name: data.name || data.login,
        meta: { login: data.login, id: data.id },
      };
    }

    if (p === 'vercel') {
      const res = await fetch('https://api.vercel.com/v2/user', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error:
            (data && data.error && data.error.message) ||
            'Vercel auth failed (' + res.status + ')',
        };
      }
      const user = data.user || data;
      return {
        ok: true,
        provider: p,
        login: user.username || user.email || user.id,
        name: user.name || user.username,
        meta: { username: user.username, email: user.email },
      };
    }

    if (p === 'supabase') {
      const projectUrl = String(meta.projectUrl || meta.url || '').replace(/\/$/, '');
      if (projectUrl) {
        const res = await fetch(projectUrl + '/rest/v1/', {
          headers: {
            apikey: token,
            Authorization: 'Bearer ' + token,
          },
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: 'Supabase key rejected for project URL' };
        }
        return {
          ok: true,
          provider: p,
          login: projectUrl,
          meta: { projectUrl },
        };
      }
      // Management API with personal access token
      const res = await fetch('https://api.supabase.com/v1/projects', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          error:
            'Supabase token rejected. Use a personal access token, or a project anon/service key + project URL.',
        };
      }
      if (!res.ok) {
        return { ok: false, error: 'Supabase probe failed (' + res.status + ')' };
      }
      const data = await res.json().catch(() => []);
      return {
        ok: true,
        provider: p,
        login: Array.isArray(data) ? data.length + ' projects' : 'ok',
        meta: { projectCount: Array.isArray(data) ? data.length : 0 },
      };
    }

    if (p === 'firebase') {
      if (token.charAt(0) === '{') {
        const j = JSON.parse(token);
        return {
          ok: true,
          provider: p,
          login: j.project_id || j.projectId || 'service-account',
          meta: {
            projectId: j.project_id || j.projectId,
            clientEmail: j.client_email,
            kind: 'service_account',
          },
        };
      }
      const projectId = meta.projectId || meta.project_id;
      if (!projectId) {
        return {
          ok: true,
          provider: p,
          login: 'api-key-saved',
          meta: { kind: 'web_api_key', note: 'Add projectId in meta for full probes' },
        };
      }
      const res = await fetch(
        'https://identitytoolkit.googleapis.com/v1/projects?key=' +
          encodeURIComponent(token),
      );
      // Many keys won't list projects; presence of non-400 is enough for format check
      if (res.status === 400) {
        const data = await res.json().catch(() => ({}));
        const msg =
          (data.error && data.error.message) || 'Firebase API key probe failed';
        if (/API key not valid/i.test(msg)) {
          return { ok: false, error: msg };
        }
      }
      return {
        ok: true,
        provider: p,
        login: projectId,
        meta: { projectId, kind: 'web_api_key' },
      };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  return { ok: false, error: 'Unhandled provider' };
}

async function connectorRequest(uid, params) {
  const p = String((params && params.provider) || '').toLowerCase();
  if (!CONNECTOR_PROVIDERS.includes(p)) {
    return { ok: false, tool: 'connector_request', error: 'Unknown provider' };
  }
  const got = await getDecryptedToken(uid, p);
  if (!got.ok) {
    return { ok: false, tool: 'connector_request', error: got.error };
  }

  const method = String((params && params.method) || 'GET').toUpperCase();
  let url = String((params && (params.url || params.path)) || '');
  if (!url) {
    return { ok: false, tool: 'connector_request', error: 'url or path required' };
  }

  // Allow path-only relative to provider API root
  if (url.charAt(0) === '/') {
    const roots = {
      github: 'https://api.github.com',
      vercel: 'https://api.vercel.com',
      supabase: String(got.meta.projectUrl || 'https://api.supabase.com').replace(/\/$/, ''),
      firebase: 'https://firebase.googleapis.com',
    };
    url = roots[p] + url;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, tool: 'connector_request', error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, tool: 'connector_request', error: 'Only https URLs allowed' };
  }
  if (!hostAllowed(p, parsed.hostname)) {
    return {
      ok: false,
      tool: 'connector_request',
      error: 'Host not allowed for ' + p + ': ' + parsed.hostname,
    };
  }

  const headers = Object.assign({}, (params && params.headers) || {});
  if (p === 'github') {
    headers.Authorization = headers.Authorization || 'Bearer ' + got.token;
    headers.Accept = headers.Accept || 'application/vnd.github+json';
    headers['User-Agent'] = headers['User-Agent'] || 'Chatre';
    headers['X-GitHub-Api-Version'] =
      headers['X-GitHub-Api-Version'] || '2022-11-28';
  } else if (p === 'vercel') {
    headers.Authorization = headers.Authorization || 'Bearer ' + got.token;
  } else if (p === 'supabase') {
    headers.apikey = headers.apikey || got.token;
    headers.Authorization = headers.Authorization || 'Bearer ' + got.token;
  } else if (p === 'firebase') {
    if (got.token.charAt(0) !== '{') {
      if (!parsed.searchParams.has('key')) {
        parsed.searchParams.set('key', got.token);
        url = parsed.toString();
      }
    } else {
      headers.Authorization = headers.Authorization || 'Bearer ' + got.token;
    }
  }

  const init = { method, headers };
  if (params && params.body != null && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    init.body =
      typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep text */
  }

  // Never echo secrets
  const safe =
    typeof data === 'string'
      ? data.slice(0, 8000)
      : JSON.parse(JSON.stringify(data).slice(0, 12000));

  return {
    ok: res.ok,
    tool: 'connector_request',
    provider: p,
    status: res.status,
    url: parsed.origin + parsed.pathname,
    data: safe,
    error: res.ok ? undefined : 'HTTP ' + res.status,
  };
}

function listStatus(doc) {
  const out = {};
  CONNECTOR_PROVIDERS.forEach((p) => {
    const blob = doc && doc[p];
    out[p] = {
      connected: !!(blob && blob.ciphertext),
      updatedAt: (blob && blob.updatedAt) || null,
      meta: blob && blob.meta
        ? {
            login: blob.meta.login || blob.meta.username || null,
            label: blob.meta.label || null,
            projectUrl: blob.meta.projectUrl || blob.meta.url || null,
            projectId: blob.meta.projectId || blob.meta.project_id || null,
            kind: blob.meta.kind || 'token',
          }
        : null,
    };
  });
  return out;
}

module.exports = {
  CONNECTOR_PROVIDERS,
  normalizeToken,
  validateConnectorToken,
  getDecryptedToken,
  testConnector,
  connectorRequest,
  listStatus,
  hostAllowed,
};
