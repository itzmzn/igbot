import { launchChromium } from '../src/browser/chromium.js';
import { INSTAGRAM_SIGNUP_URL } from '../src/config.js';
import { classifyPage } from '../src/instagram/verification.js';

function emit(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

async function main() {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.goto(INSTAGRAM_SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(2500);
    const pageState = await classifyPage(page);
    const inputs = await page.locator('input, textarea').evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        type: element.getAttribute('type') ?? element.tagName.toLowerCase(),
        name: element.getAttribute('name') ?? '',
        id: element.id ?? '',
        autocomplete: element.getAttribute('autocomplete') ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
        labels: Array.from(element.labels ?? []).map((label) => label.textContent?.trim() ?? ''),
        labelledByText: (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' '),
        parentText: (element.parentElement?.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 160),
        visible: rect.width > 0 && rect.height > 0,
      };
    }));
    const selectors = {
      emailOrPhone: inputs.filter((input) => /email|phone/i.test(`${input.name} ${input.autocomplete} ${input.ariaLabel} ${input.placeholder} ${input.labels.join(' ')} ${input.labelledByText} ${input.parentText}`)).length,
      fullName: inputs.filter((input) => /full.?name|name/i.test(`${input.name} ${input.autocomplete} ${input.ariaLabel} ${input.placeholder} ${input.labels.join(' ')} ${input.labelledByText} ${input.parentText}`)).length,
      username: inputs.filter((input) => /username/i.test(`${input.name} ${input.autocomplete} ${input.ariaLabel} ${input.placeholder} ${input.labels.join(' ')} ${input.labelledByText} ${input.parentText}`)).length,
      password: inputs.filter((input) => /password/i.test(`${input.type} ${input.name} ${input.autocomplete} ${input.ariaLabel} ${input.placeholder}`)).length,
    };
    const playwrightLocatorCounts = {
      emailLabel: await page.getByLabel(/mobile number or email|email address|email/i).count(),
      emailName: await page.locator('input[name="emailOrPhone"]').count(),
      emailType: await page.locator('input[type="email"]').count(),
      fullNameLabel: await page.getByLabel(/full name/i).count(),
      usernameLabel: await page.getByLabel(/username/i).count(),
      passwordLabel: await page.getByLabel(/password/i).count(),
      visibleTextInputs: await page.locator('input[type="text"]:visible').count(),
      signupButtonRole: await page.getByRole('button', { name: /sign up|register|create account/i }).count(),
      submitButtons: await page.locator('button[type="submit"]').count(),
      roleButtons: await page.locator('[role="button"]').count(),
    };
    const buttons = await page.locator('button, [role="button"], input[type="submit"]').evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') ?? '',
        type: element.getAttribute('type') ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        text: (element.innerText ?? element.value ?? '').trim().replace(/\s+/g, ' ').slice(0, 100),
        disabled: Boolean(element.disabled),
        visible: rect.width > 0 && rect.height > 0,
      };
    }));
    emit('instagram_form_diagnostic', {
      pageState,
      urlHost: new URL(page.url()).hostname,
      inputs,
      selectCount: await page.locator('select').count(),
      selectors,
      playwrightLocatorCounts,
      formCount: await page.locator('form').count(),
      buttons,
    });
    if (pageState.status === 'challenge') process.exitCode = 2;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  emit('instagram_form_diagnostic_failed', { kind: error.name ?? 'Error' });
  process.exitCode = 1;
});
