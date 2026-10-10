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
        autocomplete: element.getAttribute('autocomplete') ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
        visible: rect.width > 0 && rect.height > 0,
      };
    }));
    const selectors = {
      emailOrPhone: inputs.filter((input) => /email|phone/i.test(`${input.name} ${input.autocomplete} ${input.ariaLabel} ${input.placeholder}`)).length,
      fullName: inputs.filter((input) => /full.?name|name/i.test(`${input.name} ${input.autocomplete} ${input.ariaLabel} ${input.placeholder}`)).length,
      username: inputs.filter((input) => /username/i.test(`${input.name} ${input.autocomplete} ${input.ariaLabel} ${input.placeholder}`)).length,
      password: inputs.filter((input) => /password/i.test(`${input.type} ${input.name} ${input.autocomplete} ${input.ariaLabel} ${input.placeholder}`)).length,
    };
    emit('instagram_form_diagnostic', {
      pageState,
      urlHost: new URL(page.url()).hostname,
      inputs,
      selectCount: await page.locator('select').count(),
      selectors,
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
