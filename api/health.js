'use strict';

const { handleCors } = require('../lib/cors');
const { sendJson, authorized } = require('../lib/http');
const { getBackend, SITE_ID } = require('../lib/firebase');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const url = new URL(req.url, 'http://localhost');
  const wantAuth = url.searchParams.get('auth') === '1';

  if (wantAuth) {
    if (!authorized(req)) {
      return sendJson(res, 401, {
        ok: false,
        connected: false,
        status: 'unauthorized',
        error: 'Unauthorized',
        backend: getBackend(),
        siteId: SITE_ID,
      });
    }
    return sendJson(res, 200, {
      ok: true,
      connected: true,
      status: 'connected',
      service: 'chatre-api',
      siteId: SITE_ID,
      backend: getBackend(),
      projectId: process.env.FIREBASE_PROJECT_ID || 're-el-eed0d',
      workerConfigured: !!process.env.CHATRE_WORKER_URL,
      sandbox: process.env.USE_VERCEL_SANDBOX === '1',
      time: new Date().toISOString(),
    });
  }

  sendJson(res, 200, {
    ok: true,
    service: 'chatre-api',
    siteId: SITE_ID,
    backend: getBackend(),
    projectId: process.env.FIREBASE_PROJECT_ID || 're-el-eed0d',
    time: new Date().toISOString(),
  });
};
