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

export function generateUsernameWithNumericSuffix(prefix, suffixLength = 6) {
  if (typeof prefix !== 'string' || !/^[a-z0-9]{1,26}$/i.test(prefix)) {
    throw new TypeError('Username prefix must contain only letters and digits and leave room for a numeric suffix.');
  }
  if (!Number.isInteger(suffixLength) || suffixLength < 4 || suffixLength > 8 || prefix.length + suffixLength > 30) {
    throw new RangeError('Numeric username suffix must be 4–8 digits and keep the username within 30 characters.');
  }
  const suffix = randomInt(0, 10 ** suffixLength).toString().padStart(suffixLength, '0');
  return `${prefix}${suffix}`;
}
