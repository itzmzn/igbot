import { classifyPage } from './verification.js';
import { authenticatedSessionVisible } from './login.js';

export class SignupSelectorError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.name = 'SignupSelectorError';
    this.diagnostics = diagnostics;
  }
}

const FIELD_CANDIDATES = {
  email: (page) => [
    page.getByLabel(/mobile number or email|email address|email/i),
    page.locator('input[name="emailOrPhone"]'),
    page.locator('input[type="email"]'),
  ],
  fullName: (page) => [
    page.getByLabel(/full name/i),
    page.locator('input[name="fullName"]'),
    page.locator('input[autocomplete="name"]'),
  ],
  username: (page) => [
    page.getByLabel(/username/i),
    page.locator('input[name="username"]'),
    page.locator('input[autocomplete="username"]'),
  ],
  password: (page) => [
    page.getByLabel(/password/i),
    page.locator('input[name="password"]'),
    page.locator('input[type="password"]'),
  ],
};

const USERNAME_UNAVAILABLE = /(?:this\s+)?username\s+(?:is\s+)?(?:not available|unavailable|isn't available|is not available|already taken|has already been taken)|username.{0,40}(?:already taken|unavailable)|(?:not available|already taken).{0,40}username/i;

async function resolveUnique(page, field, candidates, diagnostics) {
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    if (count === 1 && await locator.isVisible().catch(() => false)) {
      if (!await locator.isEnabled().catch(() => false)) {
        diagnostics.push({ field, found: true, matchCount: 1, enabled: false });
        throw new SignupSelectorError(`The visible ${field} field is disabled; refusing to submit.`, diagnostics);
      }
      diagnostics.push({ field, found: true, matchCount: 1 });
      return locator;
    }
    if (count > 1) diagnostics.push({ field, found: false, matchCount: count, reason: 'ambiguous' });
  }
  diagnostics.push({ field, found: false, matchCount: 0 });
  throw new SignupSelectorError(`Could not identify one visible ${field} field. Instagram may have changed its signup form.`, diagnostics);
}

async function inspectSelects(page) {
  const selects = page.locator('select');
  const count = await selects.count();
  const result = [];
  for (let i = 0; i < count; i += 1) {
    const locator = selects.nth(i);
    const metadata = await locator.evaluate((element) => {
      const label = element.labels?.[0]?.textContent ?? '';
      return {
        name: element.getAttribute('name') ?? '',
        id: element.id ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        label: label.trim(),
      };
    });
    const options = await locator.locator('option').evaluateAll((items) => items.map((option) => ({
      value: option.value,
      text: option.textContent?.trim() ?? '',
    })));
    result.push({ locator, metadata, options });
  }
  return result;
}

function kindForSelect(metadata) {
  const label = `${metadata.name} ${metadata.id} ${metadata.ariaLabel} ${metadata.label}`.toLowerCase();
  if (/month/.test(label)) return 'month';
  if (/day/.test(label)) return 'day';
  if (/year/.test(label)) return 'year';
  return null;
}

function inferSelectKinds(selects) {
  const inferred = {};
  for (const item of selects) {
    const explicitKind = kindForSelect(item.metadata);
    if (explicitKind && !inferred[explicitKind]) inferred[explicitKind] = item;
  }
  if (Object.keys(inferred).length === 3) return inferred;

  const remaining = selects.filter((item) => !Object.values(inferred).includes(item));
  for (const item of remaining) {
    const useful = item.options.filter((option) => option.value !== '' && option.text !== '');
    if (!inferred.month && useful.length >= 12 && useful.length <= 13 && useful.some((option) => /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(option.text))) inferred.month = item;
    else if (!inferred.year && useful.length >= 70 && useful.length <= 150) inferred.year = item;
    else if (!inferred.day && useful.length >= 28 && useful.length <= 32) inferred.day = item;
  }
  return inferred;
}

function optionValueFor(item, kind, date) {
  const options = item.options;
  if (kind === 'year') {
    return options.find((option) => Number(option.value || option.text) === date.year)?.value ?? null;
  }
  if (kind === 'day') {
    return options.find((option) => Number(option.value || option.text) === date.day)?.value ?? null;
  }
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const monthName = monthNames[date.month - 1];
  const shortName = monthName.slice(0, 3);
  return options.find((option) => {
    const text = option.text.toLowerCase();
    const value = option.value.toLowerCase();
    return Number(value) === date.month || Number(value) === date.month - 1
      || text === monthName || text === shortName || text.startsWith(`${shortName} `);
  })?.value ?? null;
}

async function fillBirthday(page, value, diagnostics) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('Date of birth must use YYYY-MM-DD.');
  const date = { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) };
  const dateInput = page.locator('input[type="date"]');
  if (await dateInput.count() === 1 && await dateInput.isVisible().catch(() => false)) {
    await dateInput.fill(value);
    diagnostics.push({ field: 'dateOfBirth', found: true, control: 'date_input' });
    return;
  }

  const fields = inferSelectKinds(await inspectSelects(page));
  if (!fields.month || !fields.day || !fields.year) {
    diagnostics.push({ field: 'dateOfBirth', found: false, control: 'unsupported' });
    throw new SignupSelectorError('Date-of-birth controls were not recognized. Stop and review selector diagnostics before any submission.', diagnostics);
  }
  for (const kind of ['month', 'day', 'year']) {
    const option = optionValueFor(fields[kind], kind, date);
    if (option === null) throw new SignupSelectorError(`Could not match the date-of-birth ${kind} option.`, diagnostics);
    await fields[kind].locator.selectOption(option);
  }
  diagnostics.push({ field: 'dateOfBirth', found: true, control: 'selects' });
}

async function birthdayControlsPresent(page) {
  const dateInputCount = await page.locator('input[type="date"]').count().catch(() => 0);
  const selectCount = await page.locator('select').count().catch(() => 0);
  return dateInputCount === 1 || selectCount >= 3;
}

async function resolveBirthdayContinueButton(page, diagnostics) {
  const candidate = page.getByRole('button', { name: /^(next|continue|confirm)$/i });
  const count = await candidate.count().catch(() => 0);
  if (count !== 1 || !await candidate.isVisible().catch(() => false)) {
    diagnostics.push({ field: 'dateOfBirthContinue', found: false, matchCount: count });
    throw new SignupSelectorError('Could not identify one visible continue button on the date-of-birth screen.', diagnostics);
  }
  diagnostics.push({ field: 'dateOfBirthContinue', found: true, matchCount: 1 });
  return candidate;
}

async function usernameIsUnavailable(page, locator) {
  const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  if (USERNAME_UNAVAILABLE.test(bodyText.slice(0, 30_000))) return true;
  const fieldState = await locator.evaluate((element) => {
    const describedBy = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    const describedText = describedBy.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    const parentText = element.parentElement?.parentElement?.innerText ?? '';
    return `${describedText} ${parentText}`.slice(0, 1000);
  }).catch(() => '');
  return USERNAME_UNAVAILABLE.test(fieldState);
}

export async function inspectSignupForm(page) {
  const diagnostics = [];
  for (const field of ['email', 'fullName', 'username', 'password']) {
    await resolveUnique(page, field, FIELD_CANDIDATES[field](page), diagnostics);
  }
  const dateInputCount = await page.locator('input[type="date"]').count();
  const selectCount = await page.locator('select').count();
  diagnostics.push({ field: 'dateOfBirth', found: dateInputCount === 1 || selectCount >= 3, dateInputCount, selectCount });
  return diagnostics;
}

async function waitForSignupForm(page, timeoutMs = 15_000) {
  const fields = ['email', 'fullName', 'username', 'password'];
  const deadline = Date.now() + timeoutMs;
  let diagnostics = [];
  while (Date.now() <= deadline) {
    const state = await classifyPage(page);
    if (state.status !== 'unknown') return state;
    diagnostics = [];
    let allReady = true;
    for (const field of fields) {
      let ready = false;
      for (const locator of FIELD_CANDIDATES[field](page)) {
        const count = await locator.count().catch(() => 0);
        if (count === 1 && await locator.isVisible().catch(() => false)) {
          ready = true;
          break;
        }
      }
      if (!ready) {
        allReady = false;
        diagnostics.push({ field, found: false });
      }
    }
    if (allReady) return null;
    await page.waitForTimeout(250);
  }
  throw new SignupSelectorError('Signup form fields did not become visible before the bounded page-detection timeout.', diagnostics);
}

export async function runSignup(page, { email, fullName, username, usernameCandidates, password, dateOfBirth, url, authorized = false, navigate = true, waitMs = 10_000, usernameCheckWaitMs = 900, onSubmitted, onUsernameSelected, hasUnexpectedDialogs }) {
  if (authorized !== true) throw new Error('Signup submission requires explicit authorization.');
  if (navigate) {
    if (url !== 'https://www.instagram.com/accounts/emailsignup/' && !url?.startsWith('http://127.0.0.1:')) {
      throw new Error('Signup URL is not an approved Instagram page or local mock page.');
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 });
  const before = await classifyPage(page);
  if (before.status !== 'unknown') return { ...before, submitAttempted: false, diagnostics: [] };

  const pendingState = await waitForSignupForm(page);
  if (pendingState) return { ...pendingState, submitAttempted: false, diagnostics: [] };

  const diagnostics = await inspectSignupForm(page);
  if (typeof fullName !== 'string' || fullName.length === 0) throw new TypeError('A fullName value is required.');
  if (typeof password !== 'string' || password.length === 0) throw new TypeError('A password value is required.');
  if (typeof email !== 'string' || email.length === 0) {
    if (typeof onUsernameSelected !== 'function') throw new TypeError('An email value is required.');
  }
  const emailLocator = await resolveUnique(page, 'email', FIELD_CANDIDATES.email(page), diagnostics);
  const fullNameLocator = await resolveUnique(page, 'fullName', FIELD_CANDIDATES.fullName(page), diagnostics);
  const usernameLocator = await resolveUnique(page, 'username', FIELD_CANDIDATES.username(page), diagnostics);
  const passwordLocator = await resolveUnique(page, 'password', FIELD_CANDIDATES.password(page), diagnostics);
  const submitCandidates = [
    page.getByRole('button', { name: /^(?:sign up|register|create account|submit)$/i }),
    page.locator('button[type="submit"]'),
  ];
  let submit = null;
  for (const candidate of submitCandidates) {
    const count = await candidate.count().catch(() => 0);
    if (count === 1 && await candidate.isVisible().catch(() => false)) {
      if (!await candidate.isEnabled().catch(() => false)) {
        throw new SignupSelectorError('The signup submit control is disabled; refusing to submit.', diagnostics);
      }
      submit = candidate;
      break;
    }
    if (count > 1) throw new SignupSelectorError('Signup submit button is ambiguous; refusing to submit.', diagnostics);
  }
  if (!submit) throw new SignupSelectorError('Could not identify one visible signup submit button.', diagnostics);

  const candidates = usernameCandidates?.length ? usernameCandidates : [username];
  if (candidates.length > 3) throw new RangeError('At most three username candidates may be checked before submission.');
  let selectedUsername = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (typeof candidate !== 'string' || !/^[a-z0-9]{1,30}$/i.test(candidate)) throw new TypeError('A username candidate has an invalid format.');
    await usernameLocator.fill(candidate);
    await usernameLocator.press('Tab').catch(() => {});
    if (usernameCheckWaitMs > 0) await page.waitForTimeout(usernameCheckWaitMs);
    if (await usernameIsUnavailable(page, usernameLocator)) {
      diagnostics.push({ field: 'usernameAvailability', candidateIndex: index + 1, status: 'unavailable' });
      continue;
    }
    selectedUsername = candidate;
    diagnostics.push({ field: 'usernameAvailability', candidateIndex: index + 1, status: 'no_unavailable_feedback' });
    break;
  }
  if (!selectedUsername) throw new SignupSelectorError('Instagram marked all bounded username candidates unavailable before submission.', diagnostics);

  const currentBeforeMailbox = await classifyPage(page);
  if (currentBeforeMailbox.status !== 'unknown') return { ...currentBeforeMailbox, username: selectedUsername, submitAttempted: false, diagnostics };

  let resolvedEmail = email;
  if (typeof onUsernameSelected === 'function') {
    const selectedDetails = await onUsernameSelected(selectedUsername);
    if (typeof selectedDetails?.email === 'string') resolvedEmail = selectedDetails.email;
  }
  if (typeof resolvedEmail !== 'string' || resolvedEmail.length === 0) throw new TypeError('An email value is required.');
  await emailLocator.fill(resolvedEmail);
  await fullNameLocator.fill(fullName);
  await passwordLocator.fill(password);
  let birthdayFilled = false;
  if (await birthdayControlsPresent(page)) {
    await fillBirthday(page, dateOfBirth, diagnostics);
    birthdayFilled = true;
  } else {
    diagnostics.push({ field: 'dateOfBirth', found: false, control: 'deferred_screen' });
  }

  const current = await classifyPage(page);
  if (current.status !== 'unknown') return { ...current, username: selectedUsername, submitAttempted: false, diagnostics };
  if (typeof hasUnexpectedDialogs === 'function' && hasUnexpectedDialogs()) {
    return { status: 'unknown', reason: 'unexpected_dialog', username: selectedUsername, submitAttempted: false, diagnostics };
  }
  const submittedAt = new Date().toISOString();
  if (typeof onSubmitted === 'function') onSubmitted(submittedAt);
  await submit.click();

  const deadline = Date.now() + waitMs;
  const classifyPostSubmit = async () => {
    const state = await classifyPage(page);
    if (state.status === 'unknown' && await authenticatedSessionVisible(page, selectedUsername)) {
      return { status: 'confirmed', reason: 'authenticated_signup_landing' };
    }
    return state;
  };
  let result = await classifyPostSubmit();
  while (Date.now() < deadline) {
    if (typeof hasUnexpectedDialogs === 'function' && hasUnexpectedDialogs()) {
      result = { status: 'unknown', reason: 'unexpected_dialog' };
      break;
    }
    if (result.status === 'birthday_confirmation' && !birthdayFilled) {
      await fillBirthday(page, dateOfBirth, diagnostics);
      birthdayFilled = true;
      const continueButton = await resolveBirthdayContinueButton(page, diagnostics);
      await continueButton.click();
      result = await classifyPostSubmit();
      continue;
    }
    if (result.status !== 'unknown') break;
    await page.waitForTimeout(250);
    result = await classifyPostSubmit();
  }
  return { ...result, username: selectedUsername, submitAttempted: true, submittedAt, diagnostics };
}
