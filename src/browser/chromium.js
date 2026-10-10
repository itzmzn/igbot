import { chromium } from 'playwright';

export async function launchChromium(options = {}) {
  return chromium.launch({
    headless: options.headless ?? true,
    timeout: options.timeout ?? 30_000,
    args: options.args ?? [],
  });
}
