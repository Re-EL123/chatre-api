'use strict';

/**
 * Dense embedding backends for Layer 2 hybrid search.
 *
 * Default: hashed character/token n-grams → fixed dim, L2-normalized (no deps).
 * Optional remote: Workers AI / OpenAI-compatible embed URL via env.
 */

const crypto = require('crypto');

const DEFAULT_DIM = 384;
const NGRAM_N = 3;

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / n;
  return vec;
}

/**
 * Feature-hashed bag of char n-grams + whitespace tokens → Float32Array.
 */
function hashEmbed(text, dim) {
  const d = Math.min(1024, Math.max(64, Number(dim) || DEFAULT_DIM));
  const vec = new Float32Array(d);
  const raw = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
  if (!raw) return vec;

  const padded = ' ' + raw + ' ';
  for (let i = 0; i <= padded.length - NGRAM_N; i++) {
    const gram = padded.slice(i, i + NGRAM_N);
    const h = fnv1a(gram);
    const idx = h % d;
    const sign = h & 1 ? 1 : -1;
    vec[idx] += sign;
  }

  const tokens = raw.split(/[^a-z0-9_./+-]+/).filter((t) => t.length > 1 && t.length < 48);
  for (const t of tokens) {
    const h = fnv1a('tok:' + t);
    const idx = h % d;
    const sign = (h >>> 1) & 1 ? 1 : -1;
    vec[idx] += 1.6 * sign;
  }

  return l2normalize(vec);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function toArray(vec) {
  if (!vec) return null;
  if (Array.isArray(vec)) return vec;
  if (vec instanceof Float32Array) return Array.from(vec);
  return null;
}

function fromArray(arr) {
  if (!arr) return null;
  if (arr instanceof Float32Array) return arr;
  if (Array.isArray(arr)) return Float32Array.from(arr);
  return null;
}

/**
 * Embed one or many texts. backend: 'hash' | 'remote' | 'auto'
 */
async function embedTexts(texts, opts) {
  const o = opts || {};
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || ''));
  const backend = String(o.backend || process.env.CHATRE_EMBED_BACKEND || 'auto').toLowerCase();
  const dim = Number(o.dim) || DEFAULT_DIM;

  const wantRemote =
    backend === 'remote' ||
    (backend === 'auto' &&
      (process.env.CHATRE_EMBED_URL ||
        (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN)));

  if (wantRemote) {
    try {
      const remote = await remoteEmbed(list, o);
      if (remote && remote.length === list.length) return remote;
    } catch (err) {
      if (backend === 'remote') throw err;
    }
  }

  return list.map((t) => hashEmbed(t, dim));
}

function embedText(text, opts) {
  const o = opts || {};
  return hashEmbed(text, o.dim || DEFAULT_DIM);
}

async function remoteEmbed(texts, opts) {
  const o = opts || {};
  const customUrl = String(process.env.CHATRE_EMBED_URL || o.url || '').trim();
  if (customUrl) {
    const res = await fetch(customUrl, {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        o.headers || {},
        process.env.CHATRE_EMBED_TOKEN
          ? { authorization: 'Bearer ' + process.env.CHATRE_EMBED_TOKEN }
          : {},
      ),
      body: JSON.stringify({ texts: texts }),
    });
    if (!res.ok) throw new Error('embed HTTP ' + res.status);
    const data = await res.json();
    const rows = data.embeddings || data.data || data.result || [];
    return rows.map((r) => {
      const v = Array.isArray(r) ? r : r.embedding || r.vector;
      return l2normalize(Float32Array.from(v));
    });
  }

  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  const model = process.env.CHATRE_EMBED_MODEL || '@cf/baai/bge-base-en-v1.5';
  if (!account || !token) throw new Error('remote embed not configured');

  const out = [];
  for (const text of texts) {
    const res = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' +
        account +
        '/ai/run/' +
        model,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: [text] }),
      },
    );
    if (!res.ok) throw new Error('Workers AI embed HTTP ' + res.status);
    const data = await res.json();
    const vec =
      (data.result && data.result.data && data.result.data[0]) ||
      (data.result && data.result[0]) ||
      null;
    if (!vec) throw new Error('Workers AI embed empty');
    out.push(l2normalize(Float32Array.from(vec)));
  }
  return out;
}

function vectorCacheKey(hash, backend, dim) {
  return crypto
    .createHash('sha1')
    .update(String(backend || 'hash') + ':' + String(dim || DEFAULT_DIM) + ':' + String(hash || ''))
    .digest('hex');
}

module.exports = {
  DEFAULT_DIM,
  hashEmbed,
  embedText,
  embedTexts,
  cosine,
  toArray,
  fromArray,
  l2normalize,
  vectorCacheKey,
};
