'use strict';

/**
 * Call Cloudflare Worker Browser Rendering via /api/browser.
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
 * Map agent tool name + params → Worker browser action.
 */
async function runBrowserTool(tool, params, cookies) {
  const p = params || {};
  const actionMap = {
    browser_navigate: 'navigate',
    browser_click: 'click',
    browser_type: 'type',
    browser_press: 'press',
    browser_screenshot: 'screenshot',
    browser_read: 'content',
    browser_content: 'content',
    browser_evaluate: 'evaluate',
    browser_wait: 'wait',
    browser_scroll: 'scroll',
    browser: String(p.action || 'navigate'),
  };

  const action = actionMap[tool] || String(p.action || tool.replace(/^browser_/, ''));
  const body = {
    action,
    url: p.url,
    selector: p.selector,
    text: p.text != null ? p.text : p.value,
    key: p.key,
    script: p.script || p.code,
    ms: p.ms != null ? p.ms : p.timeout,
    fullPage: p.fullPage,
    x: p.x,
    y: p.y != null ? p.y : p.dy,
    cookies: Array.isArray(cookies) ? cookies : undefined,
  };

  const result = await callBrowser(body);
  return sanitizeBrowserResult(result, tool);
}

function sanitizeBrowserResult(result, tool) {
  if (!result || typeof result !== 'object') {
    return { ok: false, tool, error: 'Empty browser response' };
  }
  const out = { ...result, tool };
  if (out.screenshot_base64) {
    const len = String(out.screenshot_base64).length;
    out.screenshot = {
      mime: out.mime || 'image/jpeg',
      bytesApprox: Math.floor((len * 3) / 4),
      note: 'Screenshot captured; base64 omitted from model context',
    };
    delete out.screenshot_base64;
  }
  if (out.html) out.html = String(out.html).slice(0, 12000);
  if (out.text) out.text = String(out.text).slice(0, 12000);
  if (Array.isArray(out.cookies) && out.cookies.length > 40) {
    out.cookies = out.cookies.slice(0, 40);
  }
  return out;
}

module.exports = { callBrowser, runBrowserTool, sanitizeBrowserResult };
