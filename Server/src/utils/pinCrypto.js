import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Derive a stable 32-byte key from env.
 * Prefer PIN_ENCRYPTION_KEY; fall back to JWT_SECRET so local/dev still works.
 */
const getKey = () => {
  const secret = String(
    process.env.PIN_ENCRYPTION_KEY ||
      process.env.JWT_SECRET ||
      process.env.ACCESS_TOKEN_SECRET ||
      '',
  ).trim();
  if (!secret) {
    throw new Error('PIN_ENCRYPTION_KEY (or JWT_SECRET) is not configured.');
  }
  return crypto.createHash('sha256').update(secret).digest();
};

/** Encrypt plaintext PIN → "iv:tag:ciphertext" (hex). */
export const encryptPin = (plainPin) => {
  const text = String(plainPin ?? '').trim();
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
};

/** Decrypt "iv:tag:ciphertext" → plaintext PIN, or null if invalid. */
export const decryptPin = (payload) => {
  const raw = String(payload ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [ivHex, tagHex, dataHex] = parts;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN || !data.length) {
      return null;
    }
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
};
