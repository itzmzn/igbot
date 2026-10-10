import test from 'node:test';
import assert from 'node:assert/strict';
import { generateUsername, generateUsernameWithNumericSuffix } from '../src/generators/username.js';
import { generatePassword } from '../src/generators/password.js';
import { ageOnDate, generateRandomBirthday, isValidDateOfBirth, parseIsoDate } from '../src/generators/birthday.js';
import { createConfig, REAL_SIGNUP_CONFIRMATION } from '../src/config.js';

test('username generator returns valid, bounded, distinct-looking usernames', () => {
  const values = Array.from({ length: 200 }, () => generateUsername());
  assert.ok(values.every((value) => /^[a-z0-9]{14}$/.test(value)));
  assert.ok(new Set(values).size > 190);
  assert.throws(() => generateUsername({ length: 2 }), RangeError);
});

test('username generator preserves the supplied prefix and adds a cryptographically random numeric suffix', () => {
  const values = Array.from({ length: 100 }, () => generateUsernameWithNumericSuffix('dasunpriyanath', 6));
  assert.ok(values.every((value) => /^dasunpriyanath\d{6}$/.test(value)));
  assert.ok(new Set(values).size > 95);
  assert.throws(() => generateUsernameWithNumericSuffix('too-long-prefix-name-here', 8), /prefix/i);
  assert.throws(() => generateUsernameWithNumericSuffix('valid', 3), /suffix/i);
});

test('password generator is strong, at least twenty characters, and includes all character groups', () => {
  for (let i = 0; i < 50; i += 1) {
    const value = generatePassword();
    assert.equal(value.length, 24);
    assert.match(value, /[A-Z]/);
    assert.match(value, /[a-z]/);
    assert.match(value, /[2-9]/);
    assert.match(value, /[!@#$%^&*()\-_=+]/);
  }
  assert.throws(() => generatePassword(19), RangeError);
});

test('birthday generation creates a valid random mock date in the requested age range', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');
  const birthdays = Array.from({ length: 100 }, () => generateRandomBirthday({ now, minimumAge: 21, maximumAge: 55 }));
  for (const value of birthdays) {
    assert.ok(parseIsoDate(value));
    assert.equal(isValidDateOfBirth(value, { now, minimumAge: 21, maximumAge: 55 }), true);
  }
  assert.ok(new Set(birthdays).size > 80);
});

test('date parsing and age checks reject impossible, future, and too-young dates', () => {
  const now = new Date('2026-10-11T00:00:00.000Z');
  assert.equal(parseIsoDate('2000-02-30'), null);
  assert.equal(isValidDateOfBirth('2027-01-01', { now }), false);
  assert.equal(isValidDateOfBirth('2015-10-12', { now }), false);
  assert.equal(isValidDateOfBirth('2013-10-11', { now }), true);
  assert.equal(ageOnDate('2000-10-12', now), 25);
});

test('real mode fails closed unless exact authorization and truthful fields are provided', () => {
  assert.throws(() => createConfig({ RUN_MODE: 'real' }), /authorization/i);
  const env = {
    RUN_MODE: 'real',
    REAL_SIGNUP_AUTHORIZED: 'true',
    REAL_SIGNUP_CONFIRMATION,
    REGISTRANT_FULL_NAME: 'Test Registrant',
    REGISTRANT_DOB: '1990-06-15',
    ACCOUNT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  assert.equal(createConfig(env).authorized, true);
  assert.throws(() => createConfig({ ...env, REGISTRANT_DOB: '2018-01-01' }), /truthful, valid/i);
  assert.throws(() => createConfig({ ...env, REAL_SIGNUP_CONFIRMATION: 'yes' }), /authorization/i);
});
