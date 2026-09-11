'use strict';

/**
 * Download remote files into the workspace (text or base64).
 */

const { isBlockedUrl } = require('./computer');

function guessName(url, contentType) {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop() || 'download';
    if (base.includes('.')) return base.slice(0, 120);
    if (/pdf/i.test(contentType || '')) return base + '.pdf';
    if (/json/i.test(contentType || '')) return base + '.json';
    if (/csv/i.test(contentType || '')) return base + '.csv';
    if (/zip/i.test(contentType || '')) return base + '.zip';
    if (/png/i.test(contentType || '')) return base + '.png';
    if (/jpe?g/i.test(contentType || '')) return base + '.jpg';
    return base.slice(0, 120);
  } catch {
    return 'download-' + Date.now();
  }
}

function isTextual(ct, bytes) {
  if (/^text\/|json|xml|javascript|csv|markdown|svg/i.test(ct || '')) return true;
  // Heuristic: mostly printable ASCII
  const sample = bytes.slice(0, 512);
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  }
  return sample.length && printable / sample.length > 0.9;
}

async function downloadFile(params) {
  const p = params || {};
  const url = String(p.url || '').trim();
  if (!url) return { ok: false, error: 'url required' };
  if (isBlockedUrl(url)) {
    return { ok: false, error: 'URL blocked (private/local/non-http)' };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(Number(p.timeout) || 30000, 60000),
  );
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'ChatreBot/1.0 (+https://chatre)',
        Accept: '*/*',
      },
    });
    const ct = res.headers.get('content-type') || '';
    const ab = await res.arrayBuffer();
    const max = 4 * 1024 * 1024;
    if (ab.byteLength > max) {
      return {
        ok: false,
        error: 'File too large (max 4MB)',
        bytes: ab.byteLength,
        status: res.status,
      };
    }
    const bytes = Buffer.from(ab);
    const name = String(p.filename || p.name || guessName(url, ct)).replace(
      /[^a-zA-Z0-9._-]+/g,
      '_',
    );
    const destDir = String(p.dest_dir || '/home/user/downloads').replace(/\/$/, '');
    const path = destDir + '/' + name;
    const textual = isTextual(ct, bytes);
    const encoding = textual ? 'utf8' : 'base64';
    const content = textual ? bytes.toString('utf8') : bytes.toString('base64');

    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      path,
      content_type: ct,
      bytes: bytes.length,
      encoding,
      content,
      text: textual ? content.slice(0, 2000) : undefined,
      artifact: true,
      error: res.ok ? undefined : 'HTTP ' + res.status,
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

module.exports = { downloadFile, guessName };
