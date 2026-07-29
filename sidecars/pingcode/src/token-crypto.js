// Column-level encryption for the token store — shared by BOTH backends (the
// legacy file store and the platform-store one) so the ciphertext format is
// defined in exactly one place. A slot written by one backend decrypts with the
// other; only the storage medium differs.
//
// AES-256-GCM. Format: `gcm1:<iv b64>:<authTag b64>:<ciphertext b64>`. The key
// (32 bytes, from TOKEN_STORE_KEY) never leaves this process — in particular it
// is NEVER written into the store, so a credential column stays unusable to
// anything that can read the table (the platform's SQL viewer included).

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export const CIPHER_TAG = 'gcm1';

/** Encrypt one column value. null/undefined/'' round-trip as null. */
export function encryptValue(key, plain) {
  if (plain === undefined || plain === null || plain === '') return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [
    CIPHER_TAG,
    iv.toString('base64'),
    c.getAuthTag().toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

/** Decrypt one column value. Throws on a tampered/foreign-key ciphertext. */
export function decryptValue(key, stored) {
  if (stored === undefined || stored === null) return null;
  const [tag, ivB64, authB64, ctB64] = String(stored).split(':');
  if (tag !== CIPHER_TAG || !ivB64 || !authB64 || !ctB64) {
    throw new Error('token-store: unrecognized ciphertext format');
  }
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(authB64, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new Error(
      'token-store: decryption failed — TOKEN_STORE_KEY does not match the key '
      + 'this store was encrypted with',
    );
  }
}
