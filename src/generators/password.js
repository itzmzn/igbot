import { randomInt } from 'node:crypto';

const GROUPS = [
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  'abcdefghijkmnopqrstuvwxyz',
  '23456789',
  '!@#$%^&*()-_=+',
];
const ALL = GROUPS.join('');

function choose(chars) {
  return chars[randomInt(chars.length)];
}

export function generatePassword(length = 24) {
  if (!Number.isInteger(length) || length < 20 || length > 128) {
    throw new RangeError('Password length must be between 20 and 128 characters.');
  }

  const chars = GROUPS.map(choose);
  while (chars.length < length) chars.push(choose(ALL));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
