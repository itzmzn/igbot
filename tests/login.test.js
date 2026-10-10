import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../src/browser/chromium.js';
import { runLogin } from '../src/instagram/login.js';

const account = { username: 'igmockuser123', password: 'Mock-only-Password-123456!' };

test('login verification confirms an authenticated mock session after one login submit', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <form>
        <label>Username<input name="username"></label>
        <label>Password<input type="password" name="password"></label>
        <button type="submit">Log in</button>
      </form>
      <script>
        window.loginSubmissions = 0;
        document.querySelector('form').addEventListener('submit', event => {
          event.preventDefault();
          window.loginSubmissions += 1;
          document.body.innerHTML = '<nav><a href="/igmockuser123/">Profile</a><a href="/direct/inbox/">Inbox</a></nav>';
        });
      </script>
    </body></html>`);

    const result = await runLogin(page, { ...account, authorized: true, navigate: false, waitMs: 1000 });
    assert.equal(result.status, 'authenticated');
    assert.equal(result.submitAttempted, true);
    assert.equal(await page.evaluate(() => window.loginSubmissions), 1);
  } finally {
    await browser.close();
  }
});

test('login verification stops on a security challenge without submitting', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body><h1>Confirm it is you before continuing.</h1></body></html>');
    const result = await runLogin(page, { ...account, authorized: true, navigate: false, waitMs: 500 });
    assert.equal(result.status, 'challenge');
    assert.equal(result.reason, 'suspicious_activity');
    assert.equal(result.submitAttempted, false);
  } finally {
    await browser.close();
  }
});

test('login verification reports rejected credentials without retrying', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <form>
        <label>Username<input name="username"></label>
        <label>Password<input type="password" name="password"></label>
        <button type="submit">Log in</button>
      </form>
      <script>
        window.loginSubmissions = 0;
        document.querySelector('form').addEventListener('submit', event => {
          event.preventDefault();
          window.loginSubmissions += 1;
          document.body.innerHTML = '<div role="alert">Sorry, your password was incorrect.</div>';
        });
      </script>
    </body></html>`);
    const result = await runLogin(page, { ...account, authorized: true, navigate: false, waitMs: 1000 });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'login_rejected');
    assert.equal(await page.evaluate(() => window.loginSubmissions), 1);
  } finally {
    await browser.close();
  }
});
