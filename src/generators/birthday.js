import { randomInt } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

export function ageOnDate(birthDate, referenceDate = new Date()) {
  const birth = typeof birthDate === 'string' ? parseIsoDate(birthDate) : birthDate;
  if (!(birth instanceof Date) || Number.isNaN(birth.valueOf())) return null;
  let age = referenceDate.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = referenceDate.getUTCMonth() < birth.getUTCMonth()
    || (referenceDate.getUTCMonth() === birth.getUTCMonth() && referenceDate.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function isValidDateOfBirth(value, { now = new Date(), minimumAge = 13, maximumAge = 120 } = {}) {
  const date = parseIsoDate(value);
  if (!date) return false;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (date > today) return false;
  const age = ageOnDate(date, today);
  return age !== null && age >= minimumAge && age <= maximumAge;
}

export function generateRandomBirthday({ now = new Date(), minimumAge = 21, maximumAge = 55 } = {}) {
  if (!Number.isInteger(minimumAge) || !Number.isInteger(maximumAge) || minimumAge < 13 || maximumAge < minimumAge) {
    throw new RangeError('Birthday age range must be valid and at least 13 years old.');
  }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const earliest = new Date(Date.UTC(today.getUTCFullYear() - maximumAge, 0, 1));
  const latest = new Date(Date.UTC(today.getUTCFullYear() - minimumAge, today.getUTCMonth(), today.getUTCDate()));
  const span = Math.floor((latest.valueOf() - earliest.valueOf()) / DAY_MS) + 1;
  const date = new Date(earliest.valueOf() + randomInt(span) * DAY_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
