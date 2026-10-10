import { classifyPage } from './verification.js';

export const INSTAGRAM_LOGIN_URL = 'https://www.instagram.com/accounts/login/';

const USERNAME_CANDIDATES = (page) => [
  page.getByLabel(/phone number, username, or email|username or email|username/i),
  page.locator('input[name="username"]'),
  page.locator('input[autocomplete="username"]'),
];
const PASSWORD_CANDIDATES = (page) => [
  page.getByLabel(/password/i),
  page.locator('input[name="password"]'),
  page.locator('input[type="password"]'),
];

async function resolveUnique(page, field, candidates) {
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    if (count === 1 && await locator.isVisible().catch(() => false)) {
      if (!await locator.isEnabled().catch(() => false)) throw new Error(`Instagram login ${field} field is disabled.`);
      return locator;
    }
    if (count > 1) throw new Error(`Instagram login ${field} field is ambiguous.`);
  }
  throw new Error(`Could not identify one visible Instagram login ${field} field.`);
}

async function loginFormVisible(page) {
  const visible = async (locators) => {
    for (const locator of locators) {
      if (await locator.count().catch(() => 0) === 1 && await locator.isVisible().catch(() => false)) return true;
    }
    return false;
  };
  const hasUsername = await visible(USERNAME_CANDIDATES(page));
  const hasPassword = await visible(PASSWORD_CANDIDATES(page));
  return hasUsername && hasPassword;
}

async function waitForLoginForm(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await classifyPage(page);
    if (state.status !== 'unknown') return state;
    if (await loginFormVisible(page)) return null;
    await page.waitForTimeout(250);
  }
  return { status: 'unknown', reason: 'login_form_not_detected' };
}

export async function authenticatedSessionVisible(page, username) {
  const profile = page.locator(`a[href="/${username}/"]`).first();
  const inbox = page.locator('a[href="/direct/inbox/"], a[href^="/direct/inbox/"]').first();
  const [profileVisible, inboxVisible, loginVisible] = await Promise.all([
    profile.isVisible().catch(() => false),
    inbox.isVisible().catch(() => false),
    loginFormVisible(page),
  ]);
  return profileVisible && inboxVisible && !loginVisible;
}

export async function runLogin(page, {
  username,
  password,
  authorized = false,
  navigate = true,
  url = INSTAGRAM_LOGIN_URL,
  waitMs = 10_000,
  onSubmitted,
} = {}) {
  if (authorized !== true) throw new Error('Instagram login verification requires explicit authorization.');
  if (typeof username !== 'string' || !/^[a-z0-9._]{1,30}$/i.test(username)) throw new TypeError('A valid Instagram username is required for login verification.');
  if (typeof password !== 'string' || password.length < 20) throw new TypeError('A strong Instagram password is required for login verification.');
  if (navigate) {
    if (url !== INSTAGRAM_LOGIN_URL && !url?.startsWith('http://127.0.0.1:')) throw new Error('Login URL is not an approved Instagram page or local mock page.');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 });
  if (await authenticatedSessionVisible(page, username)) return { status: 'authenticated', reason: 'authenticated_session_detected', submitAttempted: false };

  const pending = await waitForLoginForm(page, 15_000);
  if (pending) return { ...pending, submitAttempted: false };

  const usernameField = await resolveUnique(page, 'username', USERNAME_CANDIDATES(page));
  const passwordField = await resolveUnique(page, 'password', PASSWORD_CANDIDATES(page));
  const submitCandidates = [
    page.getByRole('button', { name: /^(?:log in|login|sign in)$/i }),
    page.locator('button[type="submit"]'),
  ];
  let submit = null;
  for (const candidate of submitCandidates) {
    const count = await candidate.count().catch(() => 0);
    if (count > 1) throw new Error('Instagram login submit control is ambiguous.');
    if (count === 1 && await candidate.isVisible().catch(() => false)) {
      if (!await candidate.isEnabled().catch(() => false)) throw new Error('Instagram login submit control is disabled.');
      submit = candidate;
      break;
    }
  }
  if (!submit) throw new Error('Could not identify one visible Instagram login submit control.');

  await usernameField.fill(username);
  await passwordField.fill(password);
  await submit.click();
  const submittedAt = new Date().toISOString();
  if (typeof onSubmitted === 'function') onSubmitted(submittedAt);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const state = await classifyPage(page);
    if (state.status === 'challenge' || state.status === 'verification_required' || state.status === 'rejected' || state.status === 'validation_error') {
      return { ...state, submitAttempted: true, submittedAt };
    }
    if (await authenticatedSessionVisible(page, username)) {
      return { status: 'authenticated', reason: 'authenticated_session_detected', submitAttempted: true, submittedAt };
    }
    await page.waitForTimeout(250);
  }
  return { status: 'unknown', reason: 'login_outcome_unconfirmed', submitAttempted: true, submittedAt };
}
