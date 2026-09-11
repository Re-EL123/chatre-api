'use strict';

const { handleCors } = require('../lib/cors');
const { readBody, sendJson, requireUser } = require('../lib/http');
const users = require('../lib/users');
const { encrypt, decrypt, encryptionConfigured } = require('../lib/crypto-secrets');

const PROVIDERS = ['openrouter', 'anthropic', 'openai', 'google'];

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  const auth = await requireUser(req, res);
  if (!auth) return;

  const url = new URL(req.url, 'http://localhost');
  const byok = url.pathname.endsWith('/byok') || url.searchParams.get('action') === 'byok';

  try {
    if (byok) {
      return handleByok(req, res, auth, url);
    }

    if (req.method === 'GET') {
      const profile = await users.ensureUser(auth.uid, auth.email);
      const byokDoc = await users.getByokDoc(auth.uid);
      return sendJson(res, 200, {
        user: {
          id: profile.id,
          email: profile.email,
          displayName: profile.displayName || '',
          defaults: profile.defaults || {
            provider: 'chatre',
            model: users.DEFAULT_MODEL,
          },
          byok: users.byokConfiguredFlags(byokDoc),
          encryptionReady: encryptionConfigured(),
        },
      });
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readBody(req);
      const patch = {};
      if (body.displayName != null) patch.displayName = String(body.displayName).slice(0, 120);
      if (body.defaults) {
        patch.defaults = {};
        if (body.defaults.provider) {
          patch.defaults.provider = String(body.defaults.provider);
        }
        if (body.defaults.model) {
          patch.defaults.model = String(body.defaults.model);
        }
      }
      const profile = await users.updateUser(auth.uid, patch);
      const byokDoc = await users.getByokDoc(auth.uid);
      return sendJson(res, 200, {
        user: {
          id: profile.id,
          email: profile.email,
          displayName: profile.displayName || '',
          defaults: profile.defaults,
          byok: users.byokConfiguredFlags(byokDoc),
          encryptionReady: encryptionConfigured(),
        },
      });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message || 'me failed' });
  }
};

async function handleByok(req, res, auth, url) {
  if (!encryptionConfigured()) {
    return sendJson(res, 503, {
      error: 'BYOK_ENCRYPTION_KEY is not configured on the server',
    });
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const body = await readBody(req);
    const provider = String(body.provider || '').toLowerCase();
    const apiKey = String(body.apiKey || body.key || '').trim();
    if (!PROVIDERS.includes(provider)) {
      return sendJson(res, 400, {
        error: 'provider must be one of: ' + PROVIDERS.join(', '),
      });
    }
    if (!apiKey || apiKey.length < 8) {
      return sendJson(res, 400, { error: 'apiKey required' });
    }
    const blob = encrypt(apiKey);
    await users.setByokProvider(auth.uid, provider, blob);
    const byokDoc = await users.getByokDoc(auth.uid);
    return sendJson(res, 200, {
      ok: true,
      provider,
      byok: users.byokConfiguredFlags(byokDoc),
    });
  }

  if (req.method === 'DELETE') {
    const provider = String(
      url.searchParams.get('provider') || '',
    ).toLowerCase();
    if (!PROVIDERS.includes(provider)) {
      return sendJson(res, 400, { error: 'provider query required' });
    }
    await users.deleteByokProvider(auth.uid, provider);
    const byokDoc = await users.getByokDoc(auth.uid);
    return sendJson(res, 200, {
      ok: true,
      provider,
      byok: users.byokConfiguredFlags(byokDoc),
    });
  }

  // Optional: test key by decrypting presence only
  if (req.method === 'GET') {
    const byokDoc = await users.getByokDoc(auth.uid);
    return sendJson(res, 200, {
      byok: users.byokConfiguredFlags(byokDoc),
      encryptionReady: encryptionConfigured(),
    });
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
}

// silence unused decrypt in this file (used by providers)
void decrypt;
