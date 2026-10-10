const CHALLENGE_PATTERNS = [
  { type: 'captcha', pattern: /captcha|prove you are human|verify you are human|recaptcha/i },
  { type: 'rate_limited', pattern: /too many requests|try again later|rate.?limit|please wait a few minutes/i },
  { type: 'suspicious_activity', pattern: /suspicious (?:login|activity)|unusual activity|we detected automated behavior|confirm it.?s you/i },
  { type: 'phone_verification', pattern: /confirm your phone|phone number verification|enter your phone number|security code sent to your phone/i },
];
const EMAIL_VERIFICATION = /confirm your email|verify your email|check your email|email verification|enter the confirmation code sent to your email/i;
const SUCCESS = /welcome to instagram|your account has been created|account created successfully|thanks for signing up/i;

export async function classifyPage(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const visibleText = bodyText.slice(0, 30_000);
  const captchaFrameCount = await page.locator('iframe[title*="captcha" i], iframe[src*="captcha" i], [data-testid*="captcha" i]').count().catch(() => 0);
  if (captchaFrameCount > 0) return { status: 'challenge', reason: 'captcha' };
  for (const challenge of CHALLENGE_PATTERNS) {
    if (challenge.pattern.test(visibleText)) return { status: 'challenge', reason: challenge.type };
  }
  if (EMAIL_VERIFICATION.test(visibleText)) return { status: 'verification_required', reason: 'email_verification' };
  if (SUCCESS.test(visibleText)) return { status: 'confirmed', reason: 'success_message' };
  return { status: 'unknown', reason: 'no_known_terminal_state' };
}

export function manualVerificationInstructions(status) {
  if (status === 'verification_required') {
    return 'Instagram requires email verification. Open the encrypted account artifact, retrieve the message from Mail.tm, and complete verification manually in a trusted browser.';
  }
  if (status === 'challenge') {
    return 'Instagram presented a security challenge. Stop here and complete it manually in a trusted browser; this workflow will not bypass or retry it.';
  }
  return 'Instagram did not show a recognized confirmation state. Review the run report and complete any required steps manually.';
}
