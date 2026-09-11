'use strict';

const crypto = require('crypto');

function getKey() {
  const raw = String(process.env.BYOK_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    throw new Error('BYOK_ENCRYPTION_KEY is not configured');
  }
  // Accept hex (64 chars) or utf8 passphrase hashed to 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    alg: 'aes-256-gcm',
    updatedAt: new Date().toISOString(),
  };
}

function decrypt(blob) {
  if (!blob || !blob.ciphertext || !blob.iv || !blob.tag) {
    throw new Error('Invalid secret blob');
  }
  const key = getKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(blob.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return out.toString('utf8');
}

function encryptionConfigured() {
  return !!String(process.env.BYOK_ENCRYPTION_KEY || '').trim();
}

module.exports = { encrypt, decrypt, encryptionConfigured };
