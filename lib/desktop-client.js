'use strict';

/**
 * Run desktop_* tools via companion bridge.
 */

const companion = require('./companion');

const ACTION_MAP = {
  desktop_status: 'status',
  desktop_open: 'open',
  desktop_screenshot: 'screenshot',
  desktop_clipboard_get: 'clipboard_get',
  desktop_clipboard_set: 'clipboard_set',
  desktop_notify: 'notify',
};

async function runDesktopTool(tool, params, ctx) {
  const action = ACTION_MAP[tool] || String(tool || '').replace(/^desktop_/, '');
  const companionId =
    (params && params.companionId) ||
    (ctx && ctx.companionId) ||
    companion.DEFAULT_COMPANION;

  if (action === 'status') {
    return companion.status(companionId);
  }

  const result = await companion.runViaBridge({
    action,
    params: params || {},
    tool,
    companionId,
    timeoutMs: (params && params.timeoutMs) || 28000,
  });

  // Strip huge payloads for model context
  const out = { tool, ...result };
  if (out.screenshot_base64) {
    const len = String(out.screenshot_base64).length;
    out.screenshot = {
      mime: out.mime || 'image/jpeg',
      bytesApprox: Math.floor((len * 3) / 4),
      note: 'Desktop screenshot captured; base64 omitted from model context',
    };
    delete out.screenshot_base64;
  }
  return out;
}

function isDesktopTool(name) {
  return Object.prototype.hasOwnProperty.call(ACTION_MAP, name);
}

module.exports = { runDesktopTool, isDesktopTool, ACTION_MAP };
