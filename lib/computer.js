'use strict';

/**
 * Computer-use helpers: HTTP and lightweight network fetch for the agent.
 */

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'metadata.google.internal',
]);

function isBlockedUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // Block obvious private ranges
  if (/^(10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

async function httpRequest(params) {
  const p = params || {};
  const url = String(p.url || '').trim();
  if (!url) return { ok: false, error: 'url required' };
  if (isBlockedUrl(url)) {
    return { ok: false, error: 'URL blocked (private/local/non-http)' };
  }

  const method = String(p.method || 'GET').toUpperCase();
  const headers = {};
  if (p.headers && typeof p.headers === 'object') {
    for (const [k, v] of Object.entries(p.headers)) {
      headers[String(k)] = String(v);
    }
  }
  if (p.body != null && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Number(p.timeout) || 20000, 45000));

  try {
    const init = { method, headers, signal: controller.signal };
    if (p.body != null && method !== 'GET' && method !== 'HEAD') {
      init.body =
        typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
    }
    const res = await fetch(url, init);
    const ct = res.headers.get('content-type') || '';
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }
    const max = 40000;
    const truncated = bodyText.length > max;
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: {
        'content-type': ct,
        'content-length': res.headers.get('content-length') || '',
      },
      body: truncated ? bodyText.slice(0, max) + '\n…[truncated]' : bodyText,
      truncated,
      url: res.url || url,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { httpRequest, isBlockedUrl };
