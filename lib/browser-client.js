'use strict';

/**
 * Call Cloudflare Worker browser tools (/api/browser).
 * Retries once on dead sessions / unknown tabs.
 */

function isRetryableBrowserError(result) {
  if (!result) return true;
  if (result.ok === false) {
    const err = String(result.error || '').toLowerCase();
    return (
      /session|disconnected|target closed|browser has been closed|unknown tab|protocol error|timeout|navigating frame/.test(
        err,
      ) || result.status === 500
    );
  }
  return false;
}

async function callBrowser(body) {
  const base = String(process.env.CHATRE_WORKER_URL || '').replace(/\/$/, '');
  if (!base) {
    return {
      ok: false,
      error:
        'CHATRE_WORKER_URL is not configured — browser tools need the Worker URL (Cloudflare Browser Rendering). Set it on the API and retry.',
      browser_runtime_missing: true,
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
  const urlHint = String(p.url || '').trim();
  if (
    (tool === 'tabs_create' || tool === 'navigate') &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(urlHint)
  ) {
    return {
      ok: false,
      tool,
      error:
        'localhost URLs are not a real browser server. Call preview_project on the project path (e.g. /home/user/projects/<slug>) to open the live preview.',
      hint: 'Use preview_project, not tabs_create/navigate, for workspace HTML.',
    };
  }
  ctx._browserCreateAttempts = ctx._browserCreateAttempts || 0;
  if (tool === 'tabs_create') {
    ctx._browserCreateAttempts += 1;
    if (ctx._browserCreateAttempts > 2) {
      return {
        ok: false,
        tool,
        error:
          'tabs_create failed repeatedly. Stop retrying browser tabs. For workspace apps use preview_project; for the public web use navigate with a real https URL.',
      };
    }
  }
  let session = ctx && ctx.browserSessionId;
  let tabId =
    p.tab_id != null
      ? p.tab_id
      : p.tabId != null
        ? p.tabId
        : ctx && ctx.lastTabId;

  async function ensureTab() {
    if (
      tool === 'tabs_create' ||
      tool === 'search_web' ||
      tool === 'tabs_list' ||
      tabId != null
    ) {
      return;
    }
    if (ctx._browserCreateAttempts >= 2) {
      return;
    }
    ctx._browserCreateAttempts += 1;
    const created = await callBrowser({
      tool: 'tabs_create',
      session_id: session,
      thread_id: ctx && ctx.threadId,
      url: p.url || 'about:blank',
      wait_stable: true,
    });
    if (created && created.ok !== false) {
      if (created.session_id) {
        ctx.browserSessionId = created.session_id;
        session = created.session_id;
      }
      if (created.tab_id != null) {
        ctx.lastTabId = created.tab_id;
        tabId = created.tab_id;
        p.tab_id = created.tab_id;
      }
      if (tool !== 'navigate' && p.url && p.url !== 'about:blank') {
        await callBrowser({
          tool: 'navigate',
          session_id: ctx.browserSessionId,
          thread_id: ctx && ctx.threadId,
          tab_id: p.tab_id,
          url: p.url,
          wait_stable: true,
        });
      }
    }
  }

  await ensureTab();

  function buildBody(sessionId, tab) {
    return {
      tool,
      session_id: sessionId,
      thread_id: (ctx && ctx.threadId) || undefined,
      tab_id: p.tab_id != null ? p.tab_id : tab,
      caption: p.caption !== false,
      wait_stable: p.wait_stable !== false,
      url: p.url,
      query: p.query,
      queries: p.queries,
      ref: p.ref,
      value: p.value,
      text: p.text != null ? p.text : p.value,
      action: p.action,
      coordinate:
        p.coordinate ||
        (p.x != null && p.y != null ? [p.x, p.y] : undefined),
      x: p.x,
      y: p.y,
      depth: p.depth,
      filter: p.filter,
      ref_id: p.ref_id,
      scroll_parameters: p.scroll_parameters,
      actions: p.actions,
      fullPage: p.fullPage,
      frame_selector: p.frame_selector,
    frame_url: p.frame_url,
    frame_index: p.frame_index,
    accept_downloads: p.accept_downloads,
    selector: p.selector,
      key: p.key,
      script: p.script || p.code,
      ms: p.ms != null ? p.ms : p.timeout,
    };
  }

  let result = await callBrowser(
    buildBody((ctx && ctx.browserSessionId) || session, tabId),
  );

  if (isRetryableBrowserError(result)) {
    // Drop dead session and retry once with a fresh browser.
    if (ctx) {
      ctx.browserSessionId = '';
      ctx.lastTabId = null;
    }
    session = '';
    tabId = null;
    p.tab_id = undefined;
    await ensureTab();
    result = await callBrowser(
      buildBody((ctx && ctx.browserSessionId) || session, tabId),
    );
    if (result && typeof result === 'object') {
      result.retried = true;
    }
  }

  return sanitizeBrowserResult(result, tool, ctx);
}

function sanitizeBrowserResult(result, tool, ctx) {
  if (!result || typeof result !== 'object') {
    return { ok: false, tool, error: 'Empty browser response' };
  }
  const out = { ...result, tool };
  if (out.session_id && ctx) ctx.browserSessionId = out.session_id;
  if (out.tab_id != null && ctx) ctx.lastTabId = out.tab_id;
  if (out.session_recovered && ctx) {
    out.note =
      (out.note ? out.note + ' ' : '') +
      'Browser session was relaunched; re-read the page before using old refs.';
  }
  if (out.screenshot_base64) {
    const b64 = String(out.screenshot_base64);
    if (ctx) {
      ctx.lastScreenshotBase64 = b64;
      ctx.lastScreenshotMime = out.mime || 'image/jpeg';
    }
    const len = b64.length;
    out.screenshot_preview = b64;
    out.screenshot_ui = 'data:image/jpeg;base64,' + b64;
    out.screenshot = {
      mime: out.mime || 'image/jpeg',
      bytesApprox: Math.floor((len * 3) / 4),
      note: 'Screenshot captured; preview kept for UI, omitted from model text',
      id: out.id || 'screenshot:1',
    };
    out.hasScreenshot = true;
    delete out.screenshot_base64;
  }
  if (out.html) out.html = String(out.html).slice(0, 12000);
  if (out.text) out.text = String(out.text).slice(0, 12000);
  if (Array.isArray(out.elements) && out.elements.length > 80) {
    out.elements = out.elements.slice(0, 80);
    out.elements_truncated = true;
  }
  if (out.health && typeof out.health === 'object') {
    if (out.health.text_head) {
      out.health = {
        ...out.health,
        text_head: String(out.health.text_head).slice(0, 500),
      };
    }
  }
  return out;
}

module.exports = { callBrowser, runBrowserTool, sanitizeBrowserResult };
