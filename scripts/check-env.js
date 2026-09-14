#!/usr/bin/env node
'use strict';

/**
 * Pre-deploy env checklist for chatre-api.
 * Usage:
 *   node scripts/check-env.js
 *   npm run check-env
 *
 * Loads .env.local if present (same as selfhost).
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');

if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    });
}

const checks = [];
let failed = 0;

function ok(name, detail) {
  checks.push({ name, status: 'ok', detail });
  console.log('✓', name + (detail ? ' — ' + detail : ''));
}

function warn(name, detail) {
  checks.push({ name, status: 'warn', detail });
  console.log('⚠', name + (detail ? ' — ' + detail : ''));
}

function bad(name, detail) {
  failed += 1;
  checks.push({ name, status: 'fail', detail });
  console.log('✗', name + (detail ? ' — ' + detail : ''));
}

console.log('\nChatre API env checklist\n');

const token = String(process.env.CHATRE_API_TOKEN || '').trim();
if (!token || token === 'change-me') {
  bad('CHATRE_API_TOKEN', 'set a strong secret (required in production)');
} else if (token.length < 16) {
  warn('CHATRE_API_TOKEN', 'short token; prefer 24+ random chars');
} else {
  ok('CHATRE_API_TOKEN', 'set (' + token.length + ' chars)');
}

const projectId = process.env.FIREBASE_PROJECT_ID || 're-el-eed0d';
ok('FIREBASE_PROJECT_ID', projectId);

const siteId = process.env.SITE_ID || 'chatre';
ok('SITE_ID', siteId);

let firebaseOk = false;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const cert = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (cert.client_email && cert.private_key) {
      ok('FIREBASE_SERVICE_ACCOUNT', cert.client_email);
      firebaseOk = true;
    } else {
      bad('FIREBASE_SERVICE_ACCOUNT', 'JSON missing client_email/private_key');
    }
  } catch (e) {
    bad('FIREBASE_SERVICE_ACCOUNT', 'invalid JSON: ' + e.message);
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fs.existsSync(p)) {
    ok('GOOGLE_APPLICATION_CREDENTIALS', p);
    firebaseOk = true;
  } else {
    bad('GOOGLE_APPLICATION_CREDENTIALS', 'file not found: ' + p);
  }
} else {
  bad(
    'Firebase credentials',
    'set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS',
  );
}

const worker = String(process.env.CHATRE_WORKER_URL || '').replace(/\/$/, '');
if (!worker) {
  bad('CHATRE_WORKER_URL', 'required (e.g. https://chatre1….workers.dev)');
} else if (!/^https:\/\//i.test(worker)) {
  bad('CHATRE_WORKER_URL', 'must be https://…');
} else {
  ok('CHATRE_WORKER_URL', worker);
}

if (process.env.CHATRE_WORKER_SECRET) {
  ok('CHATRE_WORKER_SECRET', 'set');
} else {
  warn('CHATRE_WORKER_SECRET', 'optional unless Worker has CHATRE_SECRET');
}

if (process.env.USE_VERCEL_SANDBOX === '1') {
  warn(
    'USE_VERCEL_SANDBOX',
    'enabled — ensure @vercel/sandbox + Vercel tokens are configured',
  );
}

const rulesPath = path.join(root, 'firestore.rules');
if (fs.existsSync(rulesPath)) {
  const rules = fs.readFileSync(rulesPath, 'utf8');
  if (
    /match \/sites\/chatre\/\{document=\*\*\}/.test(rules) &&
    /allow read, write: if false/.test(rules)
  ) {
    ok(
      'firestore.rules',
      'deny-all for sites/chatre/** present — publish in Firebase Console',
    );
  } else {
    bad('firestore.rules', 'expected deny-all match for sites/chatre/**');
  }
} else {
  bad('firestore.rules', 'file missing');
}

// Live probes (optional network)
async function probes() {
  if (worker) {
    try {
      const res = await fetch(worker + '/', { method: 'GET' });
      if (res.ok || res.status === 404 || res.status === 405) {
        ok('Worker reachable', worker + ' → HTTP ' + res.status);
      } else {
        warn('Worker reachable', worker + ' → HTTP ' + res.status);
      }
    } catch (e) {
      warn('Worker reachable', e.message);
    }
  }

  if (firebaseOk) {
    try {
      const { getBackend, siteRef, admin } = require('../lib/firebase');
      if (getBackend() !== 'firestore') {
        warn('Firestore live', 'backend=' + getBackend());
      } else {
        admin();
        await siteRef().get();
        ok('Firestore live', 'sites/' + siteId + ' readable via Admin SDK');
      }
    } catch (e) {
      bad('Firestore live', e.message);
    }
  }

  console.log('');
  if (failed) {
    console.log('FAILED:', failed, 'required check(s). Fix before deploy.\n');
    
// ── API surface hard cap (≤12) ──────────────────────────────────
try {
  const surface = require('../lib/api-surface');
  const apiDir = path.join(root, 'api');
  const apiFiles = fs
    .readdirSync(apiDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();
  const expected = (surface.ROUTES || []).slice().sort();
  if (apiFiles.length > surface.MAX_API_FUNCTIONS) {
    bad(
      'API surface ≤' + surface.MAX_API_FUNCTIONS,
      'found ' + apiFiles.length + ' routes: ' + apiFiles.join(', '),
    );
  } else if (apiFiles.join(',') !== expected.join(',')) {
    warn(
      'API surface routes',
      'disk=[' +
        apiFiles.join(', ') +
        '] catalog=[' +
        expected.join(', ') +
        '] (' +
        apiFiles.length +
        '/' +
        surface.MAX_API_FUNCTIONS +
        ')',
    );
  } else {
    ok(
      'API surface ≤' + surface.MAX_API_FUNCTIONS,
      apiFiles.length + '/' + surface.MAX_API_FUNCTIONS + ' — ' + apiFiles.join(', '),
    );
  }
  try {
    const stack = require('../lib/secret-stack').describe();
    ok('Secret Stack', 'layers=' + stack.layers.length + ' headroom=' + stack.headroom);
  } catch (e) {
    warn('Secret Stack', e.message);
  }
} catch (e) {
  warn('API surface check', e.message);
}

process.exit(1);
  }
  console.log('All required checks passed.\n');
  process.exit(0);
}

probes();
