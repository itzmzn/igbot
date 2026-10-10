import { isValidDateOfBirth } from './generators/birthday.js';

export const INSTAGRAM_SIGNUP_URL = 'https://www.instagram.com/accounts/emailsignup/';
export const REAL_SIGNUP_CONFIRMATION = 'AUTHORIZE ONE REAL REGISTRATION';

export function createConfig(env = process.env) {
  const mode = env.RUN_MODE ?? 'real';
  if (!['real', 'mock'].includes(mode)) throw new Error('RUN_MODE must be either "real" or "mock".');
  const authorized = env.REAL_SIGNUP_AUTHORIZED === 'true'
    && env.REAL_SIGNUP_CONFIRMATION === REAL_SIGNUP_CONFIRMATION;

  if (mode === 'real' && !authorized) {
    throw new Error('Real signup is disabled. Set the workflow authorization input and exact confirmation phrase for one attempt.');
  }

  let fullName = null;
  let dateOfBirth = null;
  if (mode === 'real') {
    fullName = String(env.REGISTRANT_FULL_NAME ?? '').trim();
    dateOfBirth = String(env.REGISTRANT_DOB ?? '').trim();
    if (fullName.length < 2 || fullName.length > 100) throw new Error('REGISTRANT_FULL_NAME must be provided through a GitHub Actions secret.');
    if (!isValidDateOfBirth(dateOfBirth)) throw new Error('REGISTRANT_DOB must be a truthful, valid ISO date and meet Instagram’s minimum age.');
    if (!env.ACCOUNT_ENCRYPTION_KEY) throw new Error('ACCOUNT_ENCRYPTION_KEY is required to persist credentials safely.');
  }

  const maxPollAttempts = Number(env.MAIL_POLL_MAX_ATTEMPTS ?? 12);
  const pollIntervalMs = Number(env.MAIL_POLL_INTERVAL_MS ?? 5000);
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1 || maxPollAttempts > 30) {
    throw new Error('MAIL_POLL_MAX_ATTEMPTS must be an integer from 1 to 30.');
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 30000) {
    throw new Error('MAIL_POLL_INTERVAL_MS must be between 1000 and 30000.');
  }

  return Object.freeze({
    mode,
    authorized: mode === 'mock' || authorized,
    fullName,
    dateOfBirth,
    encryptionKey: env.ACCOUNT_ENCRYPTION_KEY ?? null,
    signupUrl: INSTAGRAM_SIGNUP_URL,
    mailPollMaxAttempts: maxPollAttempts,
    mailPollIntervalMs: pollIntervalMs,
  });
}
