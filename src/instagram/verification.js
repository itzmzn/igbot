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
const USERNAME_AVAILABLE = /(?:this\s+)?username\s+(?:is\s+)?available\b/i;
const EMAIL_REGISTERED = /(?:email address|email).{0,60}(?:already (?:registered|exists|in use|taken)|is already associated)|(?:already registered|account already exists).{0,60}(?:email|address)/i;
const BIRTHDAY_PROMPT = /(?:add|enter|confirm|select) (?:your )?(?:birthday|date of birth)|(?:what|when) (?:is|was) your (?:birthday|date of birth)/i;

async function visibleBodyText(page) {
  return page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
}

async function visibleAlertText(page) {
  return page.locator('[role="alert"], [role="status"], [aria-live], [data-testid*="error" i]')
    .evaluateAll((items) => items.filter((item) => {
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }).map((item) => item.textContent ?? '').join('\n').slice(0, 5000))
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

export async function classifyPage(page, { afterSubmit = false } = {}) {
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
  if (USERNAME_AVAILABLE.test(combined)) return { status: 'unknown', reason: 'username_available' };
  if (BIRTHDAY_PROMPT.test(visibleText) && await hasBirthdayControls(page)) {
    return { status: 'birthday_confirmation', reason: 'birthday_confirmation_required' };
  }
  if (SUCCESS.test(combined)) return { status: 'confirmed', reason: 'success_message' };

  const reason = validationReason(combined);
  if (reason !== 'form_validation' || (afterSubmit && alertText.trim().length > 0)) {
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redact known run-specific values and common personal/authentication data. */
export function sanitizeDiagnosticText(value, sensitiveValues = []) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const exactValues = [...new Set(sensitiveValues
    .filter((item) => typeof item === 'string' && item.trim().length >= 2)
    .map((item) => item.trim()))].sort((a, b) => b.length - a.length);
  for (const secret of exactValues) {
    text = text.replace(new RegExp(escapeRegExp(secret), 'gi'), '[REDACTED]');
  }
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/\b(?:sessionid|csrftoken|ds_user_id|mid|ig_did|rur)\s*[:=]\s*[A-Za-z0-9._%+/-]+/gi, '[REDACTED_COOKIE]')
    .replace(/([?&](?:access_token|auth|token|password|code|otp|session|cookie|email|phone)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\b(authorization|cookie|set-cookie|password|otp|verification code)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, '[REDACTED_PHONE]')
    .replace(/\b\d{4,8}\b/g, '[REDACTED_CODE]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 500);
}

export function safeInstagramUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return 'external://[redacted]';
    const route = safeInstagramRoute(url);
    if (route === 'signup') return 'https://www.instagram.com/accounts/emailsignup/';
    if (route === 'login') return 'https://www.instagram.com/accounts/login/';
    if (route === 'checkpoint') return 'https://www.instagram.com/checkpoint/';
    if (route === 'home') return 'https://www.instagram.com/';
    return 'https://www.instagram.com/[redacted-route]';
  } catch {
    return 'unknown://[redacted]';
  }
}

function normalizeMessage(message, sensitiveValues) {
  const text = sanitizeDiagnosticText(message.text, sensitiveValues);
  if (!text) return null;
  return {
    source: message.source,
    ...(message.field ? { field: message.field } : {}),
    text,
  };
}

export async function collectPageDiagnostics(page, { urlChanges = [], afterSubmit = false, sensitiveValues = [] } = {}) {
  const state = await classifyPage(page, { afterSubmit });
  const inspected = await page.locator('body').evaluate((body) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const inputs = [...body.querySelectorAll('input')].filter(visible);
    const buttons = [...body.querySelectorAll('button,[role="button"]')].filter(visible);
    const categoryFor = (element) => {
      const label = [...(element.labels ?? [])].map((item) => item.textContent ?? '').join(' ');
      const hints = [
        element.getAttribute('type'), element.getAttribute('name'), element.id,
        element.getAttribute('autocomplete'), element.getAttribute('aria-label'), label,
      ].join(' ').toLowerCase();
      if (/phone|mobile|tel/.test(hints) || element.getAttribute('type') === 'tel') return 'phone';
      if (/birth|birthday|date of birth|dob/.test(hints) || element.getAttribute('autocomplete') === 'bday') return 'birthday';
      if (element.getAttribute('type') === 'email' || /email|mail/.test(hints)) return 'email';
      if (element.getAttribute('type') === 'password' || /password|passwd/.test(hints)) return 'password';
      if (/user.?name|login/.test(hints)) return 'username';
      if (/full.?name|first.?name|last.?name|autocomplete.{0,5}name/.test(hints)) return 'fullName';
      return 'other';
    };
    const messages = [];
    const seen = new Set();
    const addMessage = (source, field, element) => {
      if (messages.length >= 100 || !element || !visible(element)) return;
      const text = (element.innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const key = `${source}|${field ?? ''}|${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      messages.push({ source, ...(field ? { field } : {}), text: text.slice(0, 1200) });
    };
    for (const element of body.querySelectorAll('[role="alert"], [role="status"], [aria-live], [data-testid*="error" i]')) {
      if (!visible(element)) continue;
      const role = (element.getAttribute('role') ?? '').toLowerCase();
      const live = (element.getAttribute('aria-live') ?? '').toLowerCase();
      const source = role === 'alert' ? 'alert' : role === 'status' || live ? 'status' : 'inline';
      addMessage(source, undefined, element);
    }
    const fields = [...body.querySelectorAll('input,select,textarea,[role="combobox"],[aria-invalid="true"]')].filter(visible);
    for (const element of fields) {
      const field = categoryFor(element);
      const ids = [
        ...(element.getAttribute('aria-describedby') ?? '').split(/\s+/),
        ...(element.getAttribute('aria-errormessage') ?? '').split(/\s+/),
      ].filter(Boolean);
      for (const id of ids) addMessage('field_error', field, document.getElementById(id));
      if (element.validity?.valid === false && element.validationMessage) {
        messages.push({ source: 'native_validation', field, text: element.validationMessage.slice(0, 1200) });
      }
      const scope = element.closest('label') ?? element.parentElement;
      if (scope) {
        for (const nearby of scope.querySelectorAll('[role="alert"],[role="status"],[aria-live],[data-testid*="error" i],[class*="error" i]')) {
          addMessage('field_error', field, nearby);
        }
      }
    }
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
      controls: {
        visibleInputCount: inputs.length,
        disabledInputCount: inputs.filter((input) => input.disabled).length,
        inputTypeCounts: counts,
        fields: fields.slice(0, 20).map((element) => ({
          field: categoryFor(element),
          type: ['email', 'password', 'date', 'search', 'tel', 'text'].includes((element.getAttribute('type') || '').toLowerCase())
            ? (element.getAttribute('type') || 'text').toLowerCase() : (element.tagName === 'SELECT' ? 'select' : 'other'),
          required: element.required === true || element.getAttribute('aria-required') === 'true',
          disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
          invalid: element.getAttribute('aria-invalid') === 'true',
          valid: typeof element.validity?.valid === 'boolean' ? element.validity.valid : null,
          filled: Boolean(element.value),
        })),
        birthdayControlCount: body.querySelectorAll('input[type="date"],select').length,
        visibleButtonCount: buttons.length,
        disabledButtonCount: buttons.filter((button) => button.disabled || button.getAttribute('aria-disabled') === 'true').length,
        visibleAlertCount: alerts,
        buttonKinds: [...buttonKinds].sort(),
      },
      messages,
    };
  }).catch(() => ({ controls: { inspection: 'unavailable' }, messages: [] }));

  const messages = inspected.messages
    .map((message) => normalizeMessage(message, sensitiveValues))
    .filter(Boolean)
    .slice(0, 30);
  const safeHistory = new Set(['signup', 'login', 'checkpoint', 'home', 'instagram_other', 'external', 'unknown']);

  return {
    schemaVersion: 2,
    state,
    route: safeInstagramRoute(page.url()),
    currentUrl: safeInstagramUrl(page.url()),
    urlChanges: urlChanges.slice(-20).map((route) => safeHistory.has(route) ? route : 'unknown'),
    controls: inspected.controls,
    messages,
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
