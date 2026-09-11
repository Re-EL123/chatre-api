'use strict';

/**
 * Fetch a public URL and extract readable text/markdown (no browser tab).
 */

const { httpRequest, isBlockedUrl } = require('./computer');

function stripTags(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  s = s.replace(/<(br|hr)[^>]*>/gi, '\n');
  s = s.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]).slice(0, 300) : '';
}

function extractMain(html) {
  const raw = String(html || '');
  const article = raw.match(/<article[\s\S]*?<\/article>/i);
  if (article) return article[0];
  const main = raw.match(/<main[\s\S]*?<\/main>/i);
  if (main) return main[0];
  const body = raw.match(/<body[\s\S]*?<\/body>/i);
  if (body) return body[0];
  return raw;
}

async function fetchUrl(params) {
  const p = params || {};
  const url = String(p.url || '').trim();
  if (!url) return { ok: false, error: 'url required' };
  if (isBlockedUrl(url)) {
    return { ok: false, error: 'URL blocked (private/local/non-http)' };
  }

  const res = await httpRequest({
    url,
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
      'User-Agent': 'ChatreBot/1.0 (+https://chatre)',
    },
    timeout: Math.min(Number(p.timeout) || 20000, 45000),
  });
  if (!res.ok && !res.body) {
    return { ok: false, tool: 'fetch_url', error: res.error || 'fetch failed', status: res.status };
  }

  const ct = (res.headers && res.headers['content-type']) || '';
  const max = Math.min(Number(p.max_chars) || 24000, 60000);
  let text = '';
  let title = '';
  let format = 'text';

  if (/application\/json/i.test(ct)) {
    format = 'json';
    text = String(res.body || '').slice(0, max);
    try {
      text = JSON.stringify(JSON.parse(res.body), null, 2).slice(0, max);
    } catch {
      /* keep raw */
    }
  } else if (/text\/plain/i.test(ct) || /markdown/i.test(ct)) {
    format = 'text';
    text = String(res.body || '').slice(0, max);
  } else {
    format = 'html';
    title = extractTitle(res.body);
    text = stripTags(extractMain(res.body)).slice(0, max);
  }

  return {
    ok: true,
    tool: 'fetch_url',
    url: res.url || url,
    status: res.status,
    content_type: ct,
    title,
    format,
    text,
    truncated: text.length >= max,
  };
}

module.exports = { fetchUrl, stripTags };
