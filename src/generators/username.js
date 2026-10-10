import { randomInt } from 'node:crypto';

const USERNAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateUsername({ length = 14, prefix = 'ig' } = {}) {
  if (!Number.isInteger(length) || length < 3 || length > 30) {
    throw new RangeError('Username length must be between 3 and 30 characters.');
  }
  if (!/^[a-z0-9_]{1,8}$/i.test(prefix) || prefix.length >= length) {
    throw new TypeError('Username prefix must use letters, digits, or underscores and fit the requested length.');
  }

  let suffix = '';
  for (let i = prefix.length; i < length; i += 1) {
    suffix += USERNAME_ALPHABET[randomInt(USERNAME_ALPHABET.length)];
  }
  return `${prefix}${suffix}`;
}
