/**
 * Time-based one-time passwords (RFC 6238), so a login that asks for an
 * authenticator code can be automated from the shared secret alone.
 *
 * The secret is either the base32 string an authenticator app shows under
 * "can't scan the code?" or the whole otpauth:// URI from the QR code.
 * The browser child carries its own copy of generateTotp (it is plain
 * JavaScript run with the project's Node); the tests check both against
 * the RFC vectors.
 */

import { createHmac } from 'node:crypto';
import { PlaywrightMcpError } from '../types/index.js';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpSettings {
  /** Raw secret bytes. */
  key: Buffer;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode RFC 4648 base32, ignoring case, spaces, dashes and padding. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (clean.length === 0 || /[^A-Z2-7]/.test(clean)) {
    throw new PlaywrightMcpError('The TOTP secret is not base32', 'INVALID_INPUT', {
      hint: 'Use the letters-and-digits key the authenticator setup page shows (A–Z, 2–7), or the whole otpauth:// URI.',
    });
  }
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Read a base32 secret or an otpauth://totp/… URI into settings. */
export function parseTotpSecret(raw: string): TotpSettings {
  const text = raw.trim();
  if (!/^otpauth:\/\//i.test(text)) {
    return { key: base32Decode(text), digits: 6, period: 30, algorithm: 'SHA1' };
  }
  let uri: URL;
  try {
    uri = new URL(text);
  } catch {
    throw new PlaywrightMcpError('The otpauth URI is not valid', 'INVALID_INPUT');
  }
  if (uri.host.toLowerCase() !== 'totp') {
    throw new PlaywrightMcpError(`Only time-based codes are supported, not ${uri.host}`, 'INVALID_INPUT', {
      hint: 'Counter-based (hotp) codes change on every use and cannot be generated from the secret alone.',
    });
  }
  const secret = uri.searchParams.get('secret');
  if (!secret) throw new PlaywrightMcpError('The otpauth URI has no secret', 'INVALID_INPUT');
  const digits = Number(uri.searchParams.get('digits') ?? 6);
  const period = Number(uri.searchParams.get('period') ?? 30);
  const algorithm = (uri.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
  if (![6, 7, 8].includes(digits)) throw new PlaywrightMcpError(`Unsupported TOTP digits: ${digits}`, 'INVALID_INPUT');
  if (!Number.isInteger(period) || period < 10 || period > 300) {
    throw new PlaywrightMcpError(`Unsupported TOTP period: ${period}`, 'INVALID_INPUT');
  }
  if (algorithm !== 'SHA1' && algorithm !== 'SHA256' && algorithm !== 'SHA512') {
    throw new PlaywrightMcpError(`Unsupported TOTP algorithm: ${algorithm}`, 'INVALID_INPUT');
  }
  return { key: base32Decode(secret), digits, period, algorithm };
}

/** The code for a moment (default now). */
export function generateTotp(settings: TotpSettings, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / settings.period);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  message.writeUInt32BE(counter % 0x100000000, 4);
  const hmac = createHmac(settings.algorithm.toLowerCase(), settings.key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** settings.digits).padStart(settings.digits, '0');
}

/** Seconds until the current code expires. */
export function totpSecondsLeft(settings: TotpSettings, atMs: number = Date.now()): number {
  return settings.period - (Math.floor(atMs / 1000) % settings.period);
}
