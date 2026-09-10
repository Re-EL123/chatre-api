'use strict';

/**
 * Minimal local server for chatre-api without Vercel CLI.
 * Usage: node scripts/selfhost.js
 */
const http = require('http');
const url = require('url');
const path = require('path');

try {
  require('fs').accessSync(path.join(__dirname, '..', '.env.local'));
  require('fs')
    .readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split('\n')
    .forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    });
} catch {
  /* optional */
}

const routes = {
  '/api/health': require('../api/health'),
  '/api/threads': require('../api/threads'),
  '/api/workspace': require('../api/workspace'),
  '/api/exec': require('../api/exec'),
  '/api/agent': require('../api/agent'),
};

const port = Number(process.env.PORT || 8080);

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const handler = routes[parsed.pathname];
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  // Preserve query string on req.url for handlers using URL()
  try {
    await handler(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message || 'error' }));
    }
  }
});

server.listen(port, () => {
  console.log('chatre-api listening on http://localhost:' + port);
  console.log('backend hint: set FIREBASE_SERVICE_ACCOUNT for Firestore');
});
