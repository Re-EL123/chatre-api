'use strict';

/**
 * Firebase Admin + Firestore for Chatre.
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT — JSON string of service account
 *   GOOGLE_APPLICATION_CREDENTIALS — path to JSON file
 *   FIREBASE_PROJECT_ID — re-el-eed0d
 *   SITE_ID — namespace (default chatre)
 *
 * Layout:
 *   sites/<SITE_ID>/threads/{id}
 *   sites/<SITE_ID>/threads/{id}/messages/{id}
 *   sites/<SITE_ID>/workspaces/{id}
 *   sites/<SITE_ID>/workspaces/{id}/files/{encodedPath}
 *   sites/<SITE_ID>/agentRuns/{id}
 */

const fs = require('fs');
const path = require('path');

const SITE_ID =
  String(process.env.SITE_ID || 'chatre')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 60) || 'chatre';

let _admin = null;
let _db = null;
let _backend = null;

/** In-memory fallback for local/dev without credentials */
const memory = {
  threads: new Map(),
  messages: new Map(), // threadId -> Message[]
  workspaces: new Map(), // id -> { meta, files: Map<path, file> }
  runs: new Map(),
};

function isVercel() {
  return !!(process.env.VERCEL || process.env.VERCEL_ENV);
}

function getBackend() {
  if (_backend) return _backend;
  if (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    _backend = 'firestore';
  } else if (isVercel()) {
    _backend = 'memory';
  } else {
    _backend = 'memory';
  }
  return _backend;
}

function loadCert() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return null;
}

function admin() {
  if (_admin) return _admin;
  const firebaseAdmin = require('firebase-admin');
  const cert = loadCert();
  if (!cert) throw new Error('Firebase credentials not configured');
  if (firebaseAdmin.apps.length === 0) {
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(cert),
      projectId: process.env.FIREBASE_PROJECT_ID || cert.project_id || 're-el-eed0d',
      databaseURL:
        process.env.FIREBASE_DATABASE_URL ||
        'https://re-el-eed0d-default-rtdb.firebaseio.com',
    });
  }
  _admin = firebaseAdmin;
  _db = firebaseAdmin.firestore();
  _db.settings({ ignoreUndefinedProperties: true });
  return _admin;
}

function db() {
  admin();
  return _db;
}

function siteRef() {
  return db().collection('sites').doc(SITE_ID);
}

function encodePath(filePath) {
  return Buffer.from(String(filePath || ''), 'utf8')
    .toString('base64url')
    .slice(0, 700);
}

function decodePath(encoded) {
  return Buffer.from(String(encoded), 'base64url').toString('utf8');
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  SITE_ID,
  getBackend,
  admin,
  db,
  siteRef,
  encodePath,
  decodePath,
  nowIso,
  memory,
  path,
};
