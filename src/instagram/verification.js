const CHALLENGE_PATTERNS = [
  { type: 'captcha', pattern: /captcha|prove you are human|verify you are human|recaptcha/i },
  { type: 'rate_limited', pattern: /too many requests|try again later|rate.?limit|please wait a few minutes/i },
  { type: 'suspicious_activity', pattern: /suspicious (?:login|activity)|unusual activity|we detected automated behavior|confirm (?:it.?s|it is) you/i },
  { type: 'phone_verification', pattern: /confirm your phone|phone number verification|enter your phone number|security code sent to your phone/i },
];

const EMAIL_VERIFICATION = /confirm your email|verify your email|check your email|email verification|enter the confirmation code sent to your email|(?:enter|type).{0,40}(?:confirmation|verification|security )?code.{0,40}(?:email|email address)|code.{0,40}sent.{0,20}(?:email|email address)/i;
const ADDITIONAL_SECURITY_CHECK = /two[- ]factor|authentication code|security challenge|confirm your identity|verify your identity|enter (?:the )?(?:\d{1,2}[- ]digit )?security code/i;
const SUCCESS = /welcome to instagram|your account has been created|account created successfully|thanks for signing up/i;
const USERNAME_UNAVAILABLE = /(?:this\s+)?username\s+(?:is\s+)?(?:not available|unavailable|isn't available|is not available|already taken|has already been taken)|username.{0,40}(?:already taken|unavailable)|(?:not available|already taken).{0,40}username/i;
const EMAIL_REGISTERED = /(?:email address|email).{0,60}(?:already (?:registered|exists|in use|taken)|is already associated)|(?:already registered|account already exists).{0,60}(?:email|address)/i;
const BIRTHDAY_PROMPT = /(?:add|enter|confirm|select) (?:your )?(?:birthday|date of birth)|(?:what|when) (?:is|was) your (?:birthday|date of birth)/i;

async function visibleBodyText(page) {
  return page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
}

async function visibleAlertText(page) {
  return page.locator('[role="alert"], [data-testid*="error" i]')
    .evaluateAll((items) => items.filter((item) => {
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }).map((item) => item.textContent ?? '').join('\n'))
    .catch(() => '');
}

function validationReason(text) {
  if (/email.{0,50}(?:invalid|not valid|must be valid)|(?:enter|provide|use).{0,30}valid email/i.test(text)) return 'invalid_email';
  if (/password.{0,50}(?:weak|too short|invalid|must contain)/i.test(text)) return 'password_rejected';
  if (/(?:birthday|date of birth|born).{0,60}(?:invalid|underage|too young|must be|eligible)|(?:underage|too young).{0,60}(?:birthday|age|born)/i.test(text)) return 'birthday_rejected';
  if (/required field|please fill in all|complete all fields|enter all required/i.test(text)) return 'required_fields';
  return 'form_validation';
}

async function hasBirthdayControls(page) {
  const dateInputs = await page.locator('input[type="date"]').count().catch(() => 0);
  const selects = await page.locator('select').count().catch(() => 0);
  return dateInputs === 1 || selects >= 3;
}

export async function classifyPage(page) {
  const visibleText = (await visibleBodyText(page)).slice(0, 30_000);
  const alertText = await visibleAlertText(page);
  const combined = `${visibleText}\n${alertText}`;
  const captchaFrameCount = await page.locator('iframe[title*="captcha" i], iframe[src*="captcha" i], [data-testid*="captcha" i]').count().catch(() => 0);
  if (captchaFrameCount > 0) return { status: 'challenge', reason: 'captcha' };
  for (const challenge of CHALLENGE_PATTERNS) {
    if (challenge.pattern.test(combined)) return { status: 'challenge', reason: challenge.type };
  }
  if (EMAIL_VERIFICATION.test(combined)) return { status: 'verification_required', reason: 'email_verification' };
  if (ADDITIONAL_SECURITY_CHECK.test(combined)) return { status: 'challenge', reason: 'additional_verification' };
  if (/incorrect password|password was incorrect|username or password.*incorrect|account doesn't exist|user not found/i.test(combined)) {
    return { status: 'rejected', reason: 'login_rejected' };
  }
  if (EMAIL_REGISTERED.test(combined)) return { status: 'rejected', reason: 'email_already_registered' };
  if (USERNAME_UNAVAILABLE.test(combined)) return { status: 'rejected', reason: 'username_unavailable' };
  if (BIRTHDAY_PROMPT.test(visibleText) && await hasBirthdayControls(page)) {
    return { status: 'birthday_confirmation', reason: 'birthday_confirmation_required' };
  }
  if (SUCCESS.test(combined)) return { status: 'confirmed', reason: 'success_message' };

  const reason = validationReason(combined);
  if (reason !== 'form_validation' || alertText.trim().length > 0) {
    return { status: 'validation_error', reason };
  }
  return { status: 'unknown', reason: 'no_known_terminal_state' };
}

export function safeInstagramRoute(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'instagram.com' && !parsed.hostname.endsWith('.instagram.com')) return 'external';
    const route = parsed.pathname.toLowerCase();
    if (route.startsWith('/accounts/emailsignup')) return 'signup';
    if (route.startsWith('/accounts/login')) return 'login';
    if (route.includes('checkpoint') || route.includes('challenge')) return 'checkpoint';
    if (route === '/') return 'home';
    return 'instagram_other';
  } catch {
    return 'unknown';
  }
}

export async function collectPageDiagnostics(page, { urlChanges = [] } = {}) {
  const state = await classifyPage(page);
  const controls = await page.locator('body').evaluate((body) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const inputs = [...body.querySelectorAll('input')].filter(visible);
    const buttons = [...body.querySelectorAll('button,[role="button"]')].filter(visible);
    const counts = {};
    for (const input of inputs) {
      const type = (input.getAttribute('type') || 'text').toLowerCase();
      const safeType = ['email', 'password', 'date', 'search', 'tel', 'text'].includes(type) ? type : 'other';
      counts[safeType] = (counts[safeType] ?? 0) + 1;
    }
    const buttonKinds = new Set();
    for (const button of buttons) {
      const label = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`.toLowerCase();
      if (/log in|sign in/.test(label)) buttonKinds.add('login');
      else if (/sign up|register|create account|submit/.test(label)) buttonKinds.add('submit');
      else if (/next/.test(label)) buttonKinds.add('next');
      else if (/continue|confirm/.test(label)) buttonKinds.add('continue');
      else buttonKinds.add('other');
    }
    const alerts = [...body.querySelectorAll('[role="alert"],[data-testid*="error" i]')].filter(visible).length;
    return {
      visibleInputCount: inputs.length,
      disabledInputCount: inputs.filter((input) => input.disabled).length,
      inputTypeCounts: counts,
      birthdayControlCount: body.querySelectorAll('input[type="date"],select').length,
      visibleButtonCount: buttons.length,
      disabledButtonCount: buttons.filter((button) => button.disabled || button.getAttribute('aria-disabled') === 'true').length,
      visibleAlertCount: alerts,
      buttonKinds: [...buttonKinds].sort(),
    };
  }).catch(() => ({ inspection: 'unavailable' }));

  return {
    schemaVersion: 1,
    state,
    route: safeInstagramRoute(page.url()),
    urlChanges: urlChanges.slice(-20),
    controls,
  };
}

export function manualVerificationInstructions(status) {
  if (status === 'verification_required') {
    return 'Instagram requires email verification. Download the encrypted credential artifact, decrypt it locally with your GitHub Actions encryption key, sign in to the Mail.tm inbox manually, and complete verification in a trusted browser. This workflow never reads or submits verification codes.';
  }
  if (status === 'challenge') {
    return 'Instagram presented a security challenge. Stop here and complete it manually in a trusted browser; this workflow will not bypass or retry it.';
  }
  return 'Instagram did not show a recognized confirmation state. Review the sanitized run diagnostics and check the account through Instagram manually. Do not repeat signup until its state is known.';
}
