import { classifyPage } from './verification.js';

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

async function resolveUnique(page, field, candidates, diagnostics) {
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    if (count === 1 && await locator.isVisible().catch(() => false)) {
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

async function isBirthdayStep(page) {
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return /birth|birthday|date of birth/i.test(text) && await birthdayControlsPresent(page);
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

export async function runSignup(page, { email, fullName, username, password, dateOfBirth, url, authorized = false, navigate = true, waitMs = 5000, onSubmitted }) {
  if (authorized !== true) throw new Error('Signup submission requires explicit authorization.');
  if (navigate) {
    if (url !== 'https://www.instagram.com/accounts/emailsignup/' && !url?.startsWith('http://127.0.0.1:')) {
      throw new Error('Signup URL is not an approved Instagram page or local mock page.');
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 });
  const before = await classifyPage(page);
  if (before.status === 'challenge') return { ...before, submitAttempted: false, diagnostics: [] };

  const diagnostics = await inspectSignupForm(page);
  for (const field of ['email', 'fullName', 'username', 'password']) {
    const locator = await resolveUnique(page, field, FIELD_CANDIDATES[field](page), diagnostics);
    const value = { email, fullName, username, password }[field];
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`A ${field} value is required.`);
    await locator.fill(value);
  }
  let birthdayFilled = false;
  if (await birthdayControlsPresent(page)) {
    await fillBirthday(page, dateOfBirth, diagnostics);
    birthdayFilled = true;
  } else {
    diagnostics.push({ field: 'dateOfBirth', found: false, control: 'deferred_screen' });
  }

  const submitCandidates = [
    page.getByRole('button', { name: /sign up|register|create account/i }),
    page.locator('button[type="submit"]'),
  ];
  let submit = null;
  for (const candidate of submitCandidates) {
    const count = await candidate.count().catch(() => 0);
    if (count === 1 && await candidate.isVisible().catch(() => false)) { submit = candidate; break; }
    if (count > 1) throw new SignupSelectorError('Signup submit button is ambiguous; refusing to submit.', diagnostics);
  }
  if (!submit) throw new SignupSelectorError('Could not identify one visible signup submit button.', diagnostics);

  const current = await classifyPage(page);
  if (current.status === 'challenge') return { ...current, submitAttempted: false, diagnostics };
  await submit.click();
  const submittedAt = new Date().toISOString();
  if (typeof onSubmitted === 'function') onSubmitted(submittedAt);

  const deadline = Date.now() + waitMs;
  let result = await classifyPage(page);
  while (result.status === 'unknown' && Date.now() < deadline) {
    if (!birthdayFilled && await isBirthdayStep(page)) {
      await fillBirthday(page, dateOfBirth, diagnostics);
      birthdayFilled = true;
      const continueButton = await resolveBirthdayContinueButton(page, diagnostics);
      await continueButton.click();
      result = await classifyPage(page);
      continue;
    }
    await page.waitForTimeout(250);
    result = await classifyPage(page);
  }
  return { ...result, submitAttempted: true, submittedAt, diagnostics };
}
