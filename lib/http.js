'use strict';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const token = String(process.env.CHATRE_API_TOKEN || '').trim();
  if (!token) {
    // Dev-friendly: allow when unset (local). Production must set the token.
    if (process.env.VERCEL_ENV === 'production') return false;
    return true;
  }
  const header = String(req.headers.authorization || '').trim();
  if (header === 'Bearer ' + token) return true;
  if (String(req.headers['x-chatre-key'] || '').trim() === token) return true;
  return false;
}

function requireAuth(req, res) {
  if (authorized(req)) return true;
  const token = String(process.env.CHATRE_API_TOKEN || '').trim();
  if (!token && process.env.VERCEL_ENV === 'production') {
    sendJson(res, 401, {
      error: 'Unauthorized: CHATRE_API_TOKEN is not set on the Vercel project',
    });
    return false;
  }
  sendJson(res, 401, {
    error: 'Unauthorized: missing or wrong API key (must match CHATRE_API_TOKEN)',
  });
  return false;
}

function newId(prefix) {
  return (
    (prefix || 'id') +
    '_' +
    Date.now().toString(36) +
    '_' +
    Math.random().toString(36).slice(2, 10)
  );
}

module.exports = { readBody, sendJson, authorized, requireAuth, newId };
