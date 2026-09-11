'use strict';

const { admin, getBackend } = require('./firebase');
const users = require('./users');

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

function getBearer(req) {
  const header = String(req.headers.authorization || '').trim();
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return '';
}

function serviceTokenMatch(req) {
  const token = String(process.env.CHATRE_API_TOKEN || '').trim();
  if (!token) {
    if (process.env.VERCEL_ENV === 'production') return false;
    return true;
  }
  const bearer = getBearer(req);
  if (bearer && bearer === token) return true;
  if (String(req.headers['x-chatre-key'] || '').trim() === token) return true;
  return false;
}

async function resolveAuth(req) {
  if (serviceTokenMatch(req)) {
    return { kind: 'service', uid: null, email: null };
  }

  const bearer = getBearer(req);
  if (!bearer) return null;

  if (bearer.split('.').length === 3) {
    try {
      if (getBackend() !== 'firestore') {
        // No Admin SDK — reject JWT in memory mode unless fake token
        return null;
      }
      const decoded = await admin().auth().verifyIdToken(bearer);
      const uid = decoded.uid;
      const email = decoded.email || '';
      await users.ensureUser(uid, email, {
        displayName: decoded.name || '',
      });
      return { kind: 'user', uid, email, claims: decoded };
    } catch (e) {
      return null;
    }
  }

  if (getBackend() === 'memory' && bearer.startsWith('user:')) {
    const uid = bearer.slice(5).trim();
    if (!uid) return null;
    await users.ensureUser(uid, uid + '@local.test');
    return { kind: 'user', uid, email: uid + '@local.test' };
  }

  return null;
}

/** Sync-ish health check: service token, or presence of JWT-shaped bearer */
function authorized(req) {
  if (serviceTokenMatch(req)) return true;
  const bearer = getBearer(req);
  return !!(bearer && bearer.split('.').length === 3);
}

/**
 * @returns {Promise<object|false>}
 */
async function requireAuth(req, res, opts) {
  opts = opts || {};
  const auth = await resolveAuth(req);
  if (!auth) {
    const token = String(process.env.CHATRE_API_TOKEN || '').trim();
    if (!token && process.env.VERCEL_ENV === 'production') {
      sendJson(res, 401, {
        error: 'Unauthorized: CHATRE_API_TOKEN is not set on the Vercel project',
      });
      return false;
    }
    sendJson(res, 401, {
      error:
        'Unauthorized: sign in with Firebase Auth or provide CHATRE_API_TOKEN',
    });
    return false;
  }
  if (opts.usersOnly && auth.kind !== 'user') {
    sendJson(res, 403, {
      error: 'This endpoint requires a user account (Firebase Auth)',
    });
    return false;
  }
  if (opts.serviceOnly && auth.kind !== 'service') {
    sendJson(res, 403, {
      error: 'This endpoint requires the service API token',
    });
    return false;
  }
  return auth;
}

async function requireUser(req, res) {
  return requireAuth(req, res, { usersOnly: true });
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

module.exports = {
  readBody,
  sendJson,
  authorized,
  requireAuth,
  requireUser,
  resolveAuth,
  serviceTokenMatch,
  getBearer,
  newId,
};
