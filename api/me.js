'use strict';

const { handleCors } = require('../lib/cors');
const { readBody, sendJson, requireUser } = require('../lib/http');
const users = require('../lib/users');
const { encrypt, encryptionConfigured } = require('../lib/crypto-secrets');

const PROVIDERS = ['openrouter', 'anthropic', 'openai', 'google'];

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  const auth = await requireUser(req, res);
  if (!auth) return;

  const url = new URL(req.url, 'http://localhost');
  const action = String(url.searchParams.get('action') || '').toLowerCase();
  const byok =
    url.pathname.endsWith('/byok') || action === 'byok';
  const memory = action === 'memory' || url.pathname.endsWith('/memory');
  const schedules =
    action === 'schedules' ||
    action === 'schedule' ||
    url.pathname.endsWith('/schedules');

  try {
    if (byok) {
      return handleByok(req, res, auth, url);
    }
    if (memory) {
      return handleMemory(req, res, auth, url);
    }
    if (schedules) {
      return handleSchedules(req, res, auth, url);
    }

    if (req.method === 'GET') {
      const profile = await users.ensureUser(auth.uid, auth.email);
      const byokDoc = await users.getByokDoc(auth.uid);
      return sendJson(res, 200, {
        user: {
          id: profile.id,
          email: profile.email,
          displayName: profile.displayName || '',
          role: auth.role || 'user',
          authKind: auth.kind,
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
          role: auth.role || 'user',
          authKind: auth.kind,
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

  const op = String(url.searchParams.get('op') || '').toLowerCase();
  const { testByokProvider, normalizeApiKey, validateProviderKey, PROVIDERS: BYOK_PROVIDERS } =
    require('../lib/byok-test');

  if (
    (req.method === 'POST' || req.method === 'PUT') &&
    (op === 'test' || op === 'test_connection')
  ) {
    const body = await readBody(req);
    const provider = String(body.provider || url.searchParams.get('provider') || '')
      .toLowerCase();
    const override = body.apiKey || body.key || '';
    const result = await testByokProvider(auth.uid, provider, override || undefined);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'test' || body.op === 'test') {
      const result = await testByokProvider(
        auth.uid,
        String(body.provider || '').toLowerCase(),
        body.apiKey || body.key || undefined,
      );
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    const provider = String(body.provider || '').toLowerCase();
    const apiKey = normalizeApiKey(body.apiKey || body.key || '');
    if (!BYOK_PROVIDERS.includes(provider)) {
      return sendJson(res, 400, {
        error: 'provider must be one of: ' + BYOK_PROVIDERS.join(', '),
      });
    }
    const checked = validateProviderKey(provider, apiKey);
    if (!checked.ok) {
      return sendJson(res, 400, { error: checked.error });
    }
    // Ensure Firestore user doc exists before writing secrets.
    await users.ensureUser(auth.uid, auth.email);
    const blob = encrypt(checked.key);
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

  if (req.method === 'GET') {
    const byokDoc = await users.getByokDoc(auth.uid);
    return sendJson(res, 200, {
      byok: users.byokConfiguredFlags(byokDoc),
      encryptionReady: encryptionConfigured(),
    });
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleMemory(req, res, auth, url) {
  const userMemory = require('../lib/user-memory');
  const key = url.searchParams.get('key');

  if (req.method === 'GET') {
    const result = await userMemory.memoryGet(auth.uid, key || undefined);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const body = await readBody(req);
    const result = await userMemory.memorySet(
      auth.uid,
      body.key || key,
      body.value,
    );
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (req.method === 'DELETE') {
    const result = await userMemory.memoryDelete(auth.uid, key);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleSchedules(req, res, auth, url) {
  const userMemory = require('../lib/user-memory');
  const op = String(url.searchParams.get('op') || '').toLowerCase();

  if (req.method === 'GET') {
    if (op === 'due') {
      const result = await userMemory.scheduleDue(auth.uid);
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    const result = await userMemory.scheduleList(auth.uid);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const body = await readBody(req);
    if (body.op === 'due' || op === 'due') {
      const result = await userMemory.scheduleDue(auth.uid);
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (body.op === 'cancel' || op === 'cancel') {
      const result = await userMemory.scheduleCancel(
        auth.uid,
        body.id || url.searchParams.get('id'),
      );
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    const result = await userMemory.scheduleCreate(auth.uid, body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (req.method === 'DELETE') {
    const result = await userMemory.scheduleCancel(
      auth.uid,
      url.searchParams.get('id'),
    );
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
}
