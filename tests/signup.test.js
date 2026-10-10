import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchChromium } from '../src/browser/chromium.js';
import { runSignup } from '../src/instagram/signup.js';
import { classifyPage } from '../src/instagram/verification.js';

const mockRegistration = {
  email: 'mock.user@example.invalid',
  fullName: 'Mock Example',
  username: 'igmockuser123',
  password: 'Mock-only-Password-123456!',
  dateOfBirth: '1995-04-12',
};

function formMarkup(dateControls = '<label>Date of birth<input type="date" name="birthday"></label>') {
  return `<!doctype html><html><body>
    <form aria-label="Mock signup">
      <label>Email<input type="email" name="email"></label>
      <label>Full name<input name="fullName"></label>
      <label>Username<input name="username"></label>
      <label>Password<input type="password" name="password"></label>
      ${dateControls}
      <button type="submit">Sign up</button>
    </form>
    <script>document.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); document.body.innerHTML = '<main><h1>Thanks for signing up</h1></main>';
    });</script>
  </body></html>`;
}

async function setupDebug(page, context, name) {
  const logs = { consoleErrors: [], networkFailures: [] };
  page.on('console', (message) => { if (message.type() === 'error') logs.consoleErrors.push({ type: 'console_error' }); });
  page.on('requestfailed', (request) => {
    let host = 'unknown';
    try { host = new URL(request.url()).hostname; } catch { /* omit URL */ }
    logs.networkFailures.push({ host, type: 'request_failed' });
  });
  if (process.env.DEBUG_ARTIFACTS !== '1') return { logs, stop: async () => {} };
  const directory = path.resolve('artifacts/debug');
  await mkdir(directory, { recursive: true });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  return {
    logs,
    stop: async ({ diagnostics, error } = {}) => {
      await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true }).catch(() => {});
      await context.tracing.stop({ path: path.join(directory, `${name}.trace.zip`) }).catch(() => {});
      await writeFile(path.join(directory, `${name}-diagnostics.json`), JSON.stringify({
        selectors: diagnostics ?? [],
        consoleErrors: logs.consoleErrors,
        networkFailures: logs.networkFailures,
        ...(error ? { failure: { name: error.name ?? 'Error', message: 'Mock browser test failed.' } } : {}),
      }, null, 2));
    },
  };
}

test('Chromium launches and fills the mock signup form, submits once, and recognizes completion', async (t) => {
  const browser = await launchChromium();
  const context = await browser.newContext();
  const page = await context.newPage();
  const debug = await setupDebug(page, context, 'mock-signup');
  let diagnostics = [];
  let failure;
  try {
    await page.setContent(formMarkup());
    const result = await runSignup(page, { ...mockRegistration, authorized: true, navigate: false, waitMs: 3000 });
    diagnostics = result.diagnostics;
    assert.equal(result.status, 'confirmed');
    assert.equal(result.submitAttempted, true);
    assert.equal(await page.getByRole('heading', { name: 'Thanks for signing up' }).count(), 1);
    assert.ok(diagnostics.some((entry) => entry.field === 'dateOfBirth' && entry.found));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await debug.stop({ diagnostics, error: failure });
    await browser.close();
  }
});

test('signup waits for delayed registration form hydration before resolving locators', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><p>Loading signup form</p></body></html>');
    await page.evaluate((markup) => {
      window.signupSubmissionCount = 0;
      setTimeout(() => {
        document.body.innerHTML = markup;
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          window.signupSubmissionCount += 1;
          document.body.innerHTML = '<h1>Thanks for signing up</h1>';
        });
      }, 350);
    }, `<form>
      <label>Email<input type="email" name="email"></label>
      <label>Full name<input name="fullName"></label>
      <label>Username<input name="username"></label>
      <label>Password<input type="password" name="password"></label>
      <label>Date of birth<input type="date" name="birthday"></label>
      <button type="submit">Sign up</button>
    </form>`);

    const result = await runSignup(page, {
      ...mockRegistration,
      authorized: true,
      navigate: false,
      waitMs: 1500,
      usernameCheckWaitMs: 0,
    });
    assert.equal(result.status, 'confirmed');
    assert.equal(result.submitAttempted, true);
    assert.equal(await page.evaluate(() => window.signupSubmissionCount), 1);
  } finally {
    await browser.close();
  }
});

test('Playwright selects month, day, and year when the mock form uses dropdown controls', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    const monthOptions = ['<option value="">Month</option>', ...Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${new Date(Date.UTC(2020, i, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' })}</option>`)].join('');
    const dayOptions = ['<option value="">Day</option>', ...Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`)].join('');
    const yearOptions = ['<option value="">Year</option>', ...Array.from({ length: 100 }, (_, i) => `<option value="${2026 - i}">${2026 - i}</option>`)].join('');
    const controls = `<label>Month<select name="month">${monthOptions}</select></label>
      <label>Day<select name="day">${dayOptions}</select></label>
      <label>Year<select name="year">${yearOptions}</select></label>`;
    await page.setContent(formMarkup(controls));
    const result = await runSignup(page, { ...mockRegistration, authorized: true, navigate: false, waitMs: 1000 });
    assert.equal(result.status, 'confirmed');
    assert.equal(await page.getByRole('heading', { name: 'Thanks for signing up' }).count(), 1);
  } finally {
    await browser.close();
  }
});

test('Playwright handles a separate birthday screen after the single signup submission', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <form>
        <label>Email<input type="email" name="email"></label>
        <label>Full name<input name="fullName"></label>
        <label>Username<input name="username"></label>
        <label>Password<input type="password" name="password"></label>
        <button type="submit">Sign up</button>
      </form>
      <script>
        window.signupSubmissionCount = 0;
        document.querySelector('form').addEventListener('submit', event => {
          event.preventDefault();
          window.signupSubmissionCount += 1;
          document.body.innerHTML = '<main><h1>Add your birthday</h1><label>Date of birth<input type="date" name="birthday"></label><button type="button">Next</button></main>';
          document.querySelector('button').addEventListener('click', () => { document.body.innerHTML = '<h1>Thanks for signing up</h1>'; });
        });
      </script>
    </body></html>`);

    const result = await runSignup(page, { ...mockRegistration, authorized: true, navigate: false, waitMs: 3000 });
    assert.equal(result.status, 'confirmed');
    assert.equal(result.submitAttempted, true);
    assert.equal(await page.evaluate(() => window.signupSubmissionCount), 1);
    assert.ok(result.diagnostics.some((entry) => entry.field === 'dateOfBirth' && entry.control === 'date_input'));
    assert.ok(result.diagnostics.some((entry) => entry.field === 'dateOfBirthContinue' && entry.found));
  } finally {
    await browser.close();
  }
});

test('Playwright checks username availability and selects another candidate before submitting once', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <form>
        <label>Email<input type="email" name="email"></label>
        <label>Full name<input name="fullName"></label>
        <label>Username<input name="username"></label>
        <div id="username-error" aria-live="polite"></div>
        <label>Password<input type="password" name="password"></label>
        <label>Date of birth<input type="date" name="birthday"></label>
        <button type="submit">Sign up</button>
      </form>
      <script>
        window.signupSubmissionCount = 0;
        document.querySelector('[name="username"]').addEventListener('input', event => {
          document.querySelector('#username-error').textContent = event.target.value === 'dasunpriyanath000001'
            ? "This username isn't available. Please try another."
            : '';
        });
        document.querySelector('form').addEventListener('submit', event => {
          event.preventDefault();
          window.signupSubmissionCount += 1;
          window.submittedEmail = document.querySelector('[name="email"]').value;
          document.body.innerHTML = '<h1>Thanks for signing up</h1>';
        });
      </script>
    </body></html>`);

    const result = await runSignup(page, {
      ...mockRegistration,
      username: 'dasunpriyanath000001',
      usernameCandidates: ['dasunpriyanath000001', 'dasunpriyanath000002'],
      authorized: true,
      navigate: false,
      waitMs: 3000,
      usernameCheckWaitMs: 10,
      onUsernameSelected: async () => ({ email: 'generated-alias@example.invalid' }),
    });
    assert.equal(result.status, 'confirmed');
    assert.equal(result.username, 'dasunpriyanath000002');
    assert.equal(result.submitAttempted, true);
    assert.equal(await page.evaluate(() => window.signupSubmissionCount), 1);
    assert.equal(await page.evaluate(() => window.submittedEmail), 'generated-alias@example.invalid');
    assert.ok(result.diagnostics.some((entry) => entry.field === 'usernameAvailability' && entry.candidateIndex === 1 && entry.status === 'unavailable'));
  } finally {
    await browser.close();
  }
});

test('signup recognizes Instagram’s accessible Submit control and avoids creating a mailbox before selector checks', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <label>Mobile number or email<input type="text" name="email"></label>
      <label>Full name<input name="fullName"></label>
      <label>Username<input type="search" name="username"></label>
      <label>Password<input type="password" name="password"></label>
      <label>Date of birth<input type="date" name="birthday"></label>
      <div role="button" aria-label="Submit">Submit</div>
      <script>
        window.submitCount = 0;
        document.querySelector('[role="button"]').addEventListener('click', () => {
          window.submitCount += 1;
          document.body.innerHTML = '<h1>Thanks for signing up</h1>';
        });
      </script>
    </body></html>`);
    const result = await runSignup(page, {
      ...mockRegistration,
      authorized: true,
      navigate: false,
      usernameCheckWaitMs: 0,
    });
    assert.equal(result.status, 'confirmed');
    assert.equal(await page.evaluate(() => window.submitCount), 1);

    await page.setContent(formMarkup().replace('<button type="submit">Sign up</button>', ''));
    let mailboxCallbackCalled = false;
    await assert.rejects(runSignup(page, {
      ...mockRegistration,
      authorized: true,
      navigate: false,
      usernameCheckWaitMs: 0,
      onUsernameSelected: () => { mailboxCallbackCalled = true; return { email: 'unused@example.invalid' }; },
    }), /could not identify one visible signup submit button/i);
    assert.equal(mailboxCallbackCalled, false);
  } finally {
    await browser.close();
  }
});

test('Playwright refuses to submit if every bounded username candidate is unavailable', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <form>
        <label>Email<input type="email" name="email"></label>
        <label>Full name<input name="fullName"></label>
        <label>Username<input name="username"></label>
        <div id="username-error" aria-live="polite"></div>
        <label>Password<input type="password" name="password"></label>
        <label>Date of birth<input type="date" name="birthday"></label>
        <button type="submit">Sign up</button>
      </form>
      <script>
        window.signupSubmissionCount = 0;
        document.querySelector('[name="username"]').addEventListener('input', event => {
          document.querySelector('#username-error').textContent = "This username isn't available. Please try another.";
        });
        document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.signupSubmissionCount += 1; });
      </script>
    </body></html>`);

    await assert.rejects(runSignup(page, {
      ...mockRegistration,
      username: 'dasunpriyanath000001',
      usernameCandidates: ['dasunpriyanath000001', 'dasunpriyanath000002', 'dasunpriyanath000003'],
      authorized: true,
      navigate: false,
      usernameCheckWaitMs: 10,
    }), /all bounded username candidates unavailable/i);
    assert.equal(await page.evaluate(() => window.signupSubmissionCount), 0);
  } finally {
    await browser.close();
  }
});

test('signup cannot submit without explicit authorization', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(formMarkup());
    await assert.rejects(runSignup(page, { ...mockRegistration, authorized: false, navigate: false }), /explicit authorization/i);
    assert.equal(await page.getByRole('button', { name: 'Sign up' }).count(), 1);
  } finally {
    await browser.close();
  }
});

test('CAPTCHA is reported as a challenge and the form is not submitted', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body><h1>Complete CAPTCHA to continue</h1></body></html>');
    const classification = await classifyPage(page);
    assert.deepEqual(classification, { status: 'challenge', reason: 'captcha' });
    const result = await runSignup(page, { ...mockRegistration, authorized: true, navigate: false });
    assert.equal(result.submitAttempted, false);
    assert.equal(result.status, 'challenge');
  } finally {
    await browser.close();
  }
});


test('page-state detection distinguishes verification and security challenges', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    const cases = [
      ['Please wait a few minutes before trying again.', { status: 'challenge', reason: 'rate_limited' }],
      ['We detected unusual activity. Confirm it is you.', { status: 'challenge', reason: 'suspicious_activity' }],
      ['Confirm your phone number to continue.', { status: 'challenge', reason: 'phone_verification' }],
      ['Check your email for the confirmation code.', { status: 'verification_required', reason: 'email_verification' }],
      ["This username isn't available. Please try another.", { status: 'rejected', reason: 'username_unavailable' }],
      ['A page with no known completion or challenge copy.', { status: 'unknown', reason: 'no_known_terminal_state' }],
    ];
    for (const [copy, expected] of cases) {
      await page.setContent(`<html><body><main>${copy}</main></body></html>`);
      assert.deepEqual(await classifyPage(page), expected);
    }
  } finally {
    await browser.close();
  }
});
