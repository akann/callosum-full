import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const SECRET_PREFIX = 'csk_live_';
export const DISPLAY_PREFIX_LENGTH = 12; // api_keys.prefix is CHAR(12): 'csk_live_a1b'

/** 40 base62 characters from the CSPRNG, roughly 238 bits of entropy. */
export function generateSecret(): string {
  let out = '';
  while (out.length < 40) {
    for (const byte of randomBytes(64)) {
      // Rejection sampling keeps the distribution uniform (248 = 4 * 62).
      if (byte < 248 && out.length < 40) out += ALPHABET[byte % 62];
    }
  }
  return SECRET_PREFIX + out;
}

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
export const displayPrefix = (secret: string) => secret.slice(0, DISPLAY_PREFIX_LENGTH);
