'use strict';

/**
 * Call Cloudflare Worker browser tools (/api/browser).
 */

async function callBrowser(body) {
  const base = String(process.env.CHATRE_WORKER_URL || '').replace(/\/$/, '');
  if (!base) {
    return {
      ok: false,
      error:
        'CHATRE_WORKER_URL is not configured — browser tools need the Worker URL',
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.CHATRE_WORKER_SECRET;
  if (secret) {
    headers.Authorization = 'Bearer ' + secret;
    headers['x-chatre-key'] = secret;
  }

  const res = await fetch(base + '/api/browser', {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      error:
        (data && (data.error || data.message)) ||
        'Browser request failed (' + res.status + ')',
      status: res.status,
    };
  }

  return data && typeof data === 'object' ? data : { ok: true, data };
}

/**
 * Run a browser tool, maintaining session_id + default tab_id on ctx.
 */
async function runBrowserTool(tool, params, ctx) {
  const p = { ...(params || {}) };
  const session = ctx && ctx.browserSessionId;
  const tabId =
    p.tab_id != null
      ? p.tab_id
      : p.tabId != null
        ? p.tabId
        : ctx && ctx.lastTabId;

  // Auto-create tab when needed
  if (
    tool !== 'tabs_create' &&
    tool !== 'search_web' &&
    tabId == null &&
    tool !== 'tabs_list'
  ) {
    const created = await callBrowser({
      tool: 'tabs_create',
      session_id: session,
      url: p.url || 'about:blank',
    });
    if (created && created.ok !== false) {
      if (created.session_id) ctx.browserSessionId = created.session_id;
      if (created.tab_id != null) ctx.lastTabId = created.tab_id;
      p.tab_id = created.tab_id;
      // If navigate was requested with url and we just created blank, fall through to navigate
      if (tool === 'navigate' && p.url) {
        /* continue */
      } else if (tool !== 'navigate' && p.url && p.url !== 'about:blank') {
        await callBrowser({
          tool: 'navigate',
          session_id: ctx.browserSessionId,
          tab_id: p.tab_id,
          url: p.url,
        });
      }
    }
  }

  const body = {
    tool,
    session_id: (ctx && ctx.browserSessionId) || session,
    tab_id: p.tab_id != null ? p.tab_id : tabId,
    url: p.url,
    query: p.query,
    queries: p.queries,
    ref: p.ref,
    value: p.value,
    text: p.text != null ? p.text : p.value,
    action: p.action,
    coordinate: p.coordinate || (p.x != null && p.y != null ? [p.x, p.y] : undefined),
    x: p.x,
    y: p.y,
    depth: p.depth,
    filter: p.filter,
    ref_id: p.ref_id,
    scroll_parameters: p.scroll_parameters,
    actions: p.actions,
    fullPage: p.fullPage,
    selector: p.selector,
    key: p.key,
    script: p.script || p.code,
    ms: p.ms != null ? p.ms : p.timeout,
  };

  const result = await callBrowser(body);
  return sanitizeBrowserResult(result, tool, ctx);
}

function sanitizeBrowserResult(result, tool, ctx) {
  if (!result || typeof result !== 'object') {
    return { ok: false, tool, error: 'Empty browser response' };
  }
  const out = { ...result, tool };
  if (out.session_id && ctx) ctx.browserSessionId = out.session_id;
  if (out.tab_id != null && ctx) ctx.lastTabId = out.tab_id;
  if (out.screenshot_base64) {
    const len = String(out.screenshot_base64).length;
    out.screenshot = {
      mime: out.mime || 'image/jpeg',
      bytesApprox: Math.floor((len * 3) / 4),
      note: 'Screenshot captured; base64 omitted from model context',
      id: out.id || 'screenshot:1',
    };
    delete out.screenshot_base64;
  }
  if (out.html) out.html = String(out.html).slice(0, 12000);
  if (out.text) out.text = String(out.text).slice(0, 12000);
  if (Array.isArray(out.elements) && out.elements.length > 80) {
    out.elements = out.elements.slice(0, 80);
    out.elements_truncated = true;
  }
  return out;
}

module.exports = { callBrowser, runBrowserTool, sanitizeBrowserResult };
