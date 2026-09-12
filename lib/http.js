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
    // Never treat arbitrary requests as "service" — that blocked signed-in
    // users on preview/dev when CHATRE_API_TOKEN was unset.
    return false;
  }
  const bearer = getBearer(req);
  // A Firebase ID token is a 3-part JWT — never treat it as the service key.
  if (bearer && bearer.split('.').length === 3 && bearer !== token) {
    return false;
  }
  if (bearer && bearer === token) return true;
  if (String(req.headers['x-chatre-key'] || '').trim() === token) return true;
  return false;
}

function adminEmails() {
  return String(process.env.CHATRE_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function resolveRole(authBase) {
  if (!authBase) return null;
  if (authBase.kind === 'service') {
    return Object.assign({}, authBase, { role: 'admin' });
  }
  const claims = authBase.claims || {};
  const email = String(authBase.email || '').toLowerCase();
  const claimAdmin =
    claims.admin === true ||
    claims.role === 'admin' ||
    (Array.isArray(claims.roles) && claims.roles.indexOf('admin') >= 0);
  const emailAdmin = email && adminEmails().indexOf(email) >= 0;
  const role = claimAdmin || emailAdmin ? 'admin' : 'user';
  return Object.assign({}, authBase, { role });
}

async function resolveAuth(req) {
  const bearer = getBearer(req);

  // Prefer Firebase user sessions over the site service token.
  if (bearer && bearer.split('.').length === 3) {
    const siteToken = String(process.env.CHATRE_API_TOKEN || '').trim();
    if (!siteToken || bearer !== siteToken) {
      try {
        if (getBackend() === 'firestore') {
          const decoded = await admin().auth().verifyIdToken(bearer);
          const uid = decoded.uid;
          const email = decoded.email || '';
          await users.ensureUser(uid, email, {
            displayName: decoded.name || '',
          });
          return resolveRole({
            kind: 'user',
            uid,
            email,
            claims: decoded,
          });
        }
      } catch (e) {
        // Fall through to service-token / other auth.
      }
    }
  }

  if (serviceTokenMatch(req)) {
    return resolveRole({ kind: 'service', uid: null, email: null });
  }

  if (!bearer) return null;

  if (getBackend() === 'memory' && bearer.startsWith('user:')) {
    const uid = bearer.slice(5).trim();
    if (!uid) return null;
    await users.ensureUser(uid, uid + '@local.test');
    return resolveRole({
      kind: 'user',
      uid,
      email: uid + '@local.test',
      claims: {},
    });
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
      error: 'Unauthorized: sign in with Firebase Auth (users) or admin service token',
    });
    return false;
  }
  if (opts.usersOnly && auth.kind !== 'user') {
    sendJson(res, 403, {
      error:
        'This endpoint requires a signed-in user. The admin service token cannot access user data (RBAC).',
    });
    return false;
  }
  if (opts.serviceOnly && auth.kind !== 'service') {
    sendJson(res, 403, {
      error: 'This endpoint requires the admin service API token',
    });
    return false;
  }
  if (opts.adminOnly && auth.role !== 'admin') {
    sendJson(res, 403, {
      error: 'Admin role required',
    });
    return false;
  }
  return auth;
}

async function requireUser(req, res) {
  return requireAuth(req, res, { usersOnly: true });
}

async function requireAdmin(req, res) {
  return requireAuth(req, res, { adminOnly: true });
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
  requireAdmin,
  resolveAuth,
  resolveRole,
  serviceTokenMatch,
  getBearer,
  newId,
};
