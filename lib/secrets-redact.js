'use strict';

/**
 * Redact secrets from logs, SSE payloads, and audit exports.
 */

const SECRET_PATTERNS = [
  /\b(sk-[a-zA-Z0-9_-]{12,})\b/g,
  /\b(sk-ant-[a-zA-Z0-9_-]{12,})\b/g,
  /\b(sk-or-[a-zA-Z0-9_-]{12,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{20,})\b/g,
  /\b(ghp_[a-zA-Z0-9]{20,})\b/g,
  /\b(gho_[a-zA-Z0-9]{20,})\b/g,
  /\b(github_pat_[a-zA-Z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[a-zA-Z0-9-]{10,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._\-+=\/]{12,}/gi,
  /\b(api[_-]?key|token|secret|password|private_key)\s*[:=]\s*["']?([^\s"',]{8,})/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /"private_key"\s*:\s*"[^"]+"/g,
];

const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'private_key',
  'privateKey',
  'accessToken',
  'refreshToken',
  'credential',
  'credentials',
  'byok',
]);

function redactString(input) {
  let s = String(input == null ? '' : input);
  SECRET_PATTERNS.forEach((re) => {
    s = s.replace(re, (m, g1) => {
      if (/^Bearer\s+/i.test(m)) return String(g1 || 'Bearer ') + '[REDACTED]';
      if (/api[_-]?key|token|secret|password|private_key/i.test(m) && g1) {
        return m.replace(g1, '[REDACTED]');
      }
      return '[REDACTED]';
    });
  });
  return s;
}

function redactValue(value, depth) {
  const d = depth || 0;
  if (d > 8) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, d + 1));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => {
      if (SENSITIVE_KEYS.has(k) || /secret|password|token|private/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactValue(value[k], d + 1);
      }
    });
    return out;
  }
  return String(value);
}

function safeEmit(emit, event) {
  if (typeof emit !== 'function') return;
  try {
    emit(redactValue(event));
  } catch (e) {
    try {
      emit({ type: 'error', error: 'emit failed' });
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  redactString,
  redactValue,
  safeEmit,
  SECRET_PATTERNS,
};
