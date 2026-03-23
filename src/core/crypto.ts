/**
 * Shared AES-256-GCM encryption for cookie and credential persistence.
 *
 * Used by SessionManager, AuthManager, and PersistentSessionManager
 * to encrypt sensitive data at rest. Single source of truth — no
 * duplicate implementations in service files.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger';

export const ALGORITHM = 'aes-256-gcm';
export const IV_LENGTH = 16;
export const AUTH_TAG_LENGTH = 16;
export const KEY_LENGTH = 32;
export const SALT_LENGTH = 32;

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns: [iv (16)] [authTag (16)] [ciphertext (...)]
 */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt AES-256-GCM ciphertext.
 * Expects: [iv (16)] [authTag (16)] [ciphertext (...)]
 */
export function decrypt(data: Buffer, key: Buffer): string {
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Load an encryption key from disk, or generate + persist a new one.
 * Key file stores: [salt (32)] [derived-key (32)]
 *
 * @param keyFilePath - absolute path to the key file
 * @param label - human-readable label for log messages (e.g., "session", "auth")
 */
export async function loadOrCreateKey(keyFilePath: string, label: string): Promise<Buffer> {
  const dir = dirname(keyFilePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  if (existsSync(keyFilePath)) {
    const raw = await readFile(keyFilePath);
    if (raw.length === SALT_LENGTH + KEY_LENGTH) {
      logger.debug(`${label} encryption key loaded from disk`);
      return raw.subarray(SALT_LENGTH, SALT_LENGTH + KEY_LENGTH);
    }
    logger.warn(`${label} encryption key file invalid, regenerating`);
  }

  // Generate fresh key material
  const salt = randomBytes(SALT_LENGTH);
  const secret = randomBytes(64);
  const derived = scryptSync(secret, salt, KEY_LENGTH) as Buffer;

  await writeFile(keyFilePath, Buffer.concat([salt, derived]));
  logger.info(`new ${label} encryption key generated and stored`);

  return derived;
}
