'use strict';

const { handleCors } = require('../lib/cors');
const { sendJson } = require('../lib/http');
const { getBackend, SITE_ID } = require('../lib/firebase');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
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
