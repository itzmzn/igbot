import path from 'node:path';
import { createConfig, INSTAGRAM_SIGNUP_URL } from './config.js';
import { launchChromium } from './browser/chromium.js';
import { generateUsername } from './generators/username.js';
import { generatePassword } from './generators/password.js';
import { generateRandomBirthday } from './generators/birthday.js';
import { MailTmClient } from './mail/mailtm.js';
import { runSignup } from './instagram/signup.js';
import { manualVerificationInstructions } from './instagram/verification.js';
import { decodeEncryptionKey, saveAccount } from './storage/account.js';

function emit(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function safeNetworkDiagnostics(page) {
  const diagnostics = { consoleErrors: [], networkFailures: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push({ type: 'console_error' });
  });
  page.on('requestfailed', (request) => {
    let host = 'unknown';
    try { host = new URL(request.url()).hostname; } catch { /* omit malformed URL */ }
    diagnostics.networkFailures.push({ host, type: 'request_failed' });
  });
  return diagnostics;
}

async function runMock(config) {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <form aria-label="Mock signup">
        <label>Email<input type="email" name="email" /></label>
        <label>Full name<input name="fullName" /></label>
        <label>Username<input name="username" /></label>
        <label>Password<input type="password" name="password" /></label>
        <label>Date of birth<input type="date" name="birthday" /></label>
        <button type="submit">Sign up</button>
      </form>
      <script>document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); document.body.innerHTML = '<h1>Thanks for signing up</h1>'; });</script>
    </body></html>`);
    const result = await runSignup(page, {
      email: 'mock@example.invalid', fullName: 'Mock Example', username: generateUsername(),
      password: generatePassword(), dateOfBirth: generateRandomBirthday(),
      authorized: true, navigate: false,
    });
    emit('mock_signup_complete', { status: result.status, submitAttempted: result.submitAttempted });
  } finally {
    await browser.close();
  }
}

async function runReal(config) {
  if (!config.authorized) throw new Error('Real registration authorization is required.');
  // Validate the key before creating a mailbox or navigating to Instagram.
  decodeEncryptionKey(config.encryptionKey);

  const username = generateUsername();
  const password = generatePassword();
  const mailPassword = generatePassword();
  const mailboxClient = new MailTmClient();
  const mailbox = await mailboxClient.createMailbox({ username: `${username}mail`, password: mailPassword });
  emit('mailbox_created', { status: 'ready' });

  const browser = await launchChromium();
  let result;
  let diagnostics;
  try {
    const page = await browser.newPage();
    diagnostics = safeNetworkDiagnostics(page);
    result = await runSignup(page, {
      email: mailbox.address,
      fullName: config.fullName,
      username,
      password,
      dateOfBirth: config.dateOfBirth,
      url: INSTAGRAM_SIGNUP_URL,
      authorized: true,
      navigate: true,
    });

    if (result.status === 'challenge' && !result.submitAttempted) {
      emit('registration_stopped', { status: 'security_challenge', submitAttempted: false, reason: result.reason });
      process.exitCode = 2;
      return;
    }

    let verificationMessage = null;
    if (result.status === 'verification_required') {
      const inbox = await mailboxClient.pollInbox(mailbox.token, {
        maxAttempts: config.mailPollMaxAttempts,
        intervalMs: config.mailPollIntervalMs,
      });
      if (inbox.messages[0]?.id) {
        // Retrieve the message for later manual review; this code never extracts or enters verification codes.
        verificationMessage = await mailboxClient.getMessage(mailbox.token, String(inbox.messages[0].id));
      }
      emit('manual_verification_required', {
        status: 'awaiting_manual_verification',
        messageAvailable: Boolean(verificationMessage),
        instructions: manualVerificationInstructions(result.status),
      });
    } else if (result.status === 'challenge') {
      emit('manual_verification_required', {
        status: 'security_challenge',
        instructions: manualVerificationInstructions(result.status),
      });
    } else if (result.status === 'unknown') {
      emit('registration_unconfirmed', { status: 'registration_unconfirmed' });
    } else {
      emit('registration_confirmed', { status: 'confirmed' });
    }

    const status = result.status === 'confirmed' ? 'confirmed'
      : result.status === 'verification_required' ? 'awaiting_manual_verification'
        : result.status === 'challenge' ? 'security_challenge' : 'registration_unconfirmed';
    const stored = await saveAccount({
      username,
      email: mailbox.address,
      status,
      encryptionKey: config.encryptionKey,
      credentials: {
        username,
        password,
        email: mailbox.address,
        mailboxPassword,
        ...(verificationMessage ? { verificationMessage } : {}),
      },
      directory: path.resolve('accounts'),
      createdAt: result.submittedAt,
    });
    emit('account_artifact_prepared', {
      status,
      metadataPath: path.relative(process.cwd(), stored.metadataPath),
      encryptedCredentialsPath: path.relative(process.cwd(), stored.credentialPath),
      diagnostics: {
        consoleErrorCount: diagnostics.consoleErrors.length,
        networkFailureCount: diagnostics.networkFailures.length,
      },
    });
    if (status !== 'confirmed') process.exitCode = 2;
  } finally {
    await browser.close();
  }
}

async function main() {
  const config = createConfig();
  if (config.mode === 'mock') return runMock(config);
  return runReal(config);
}

main().catch((error) => {
  // Error messages originate from our sanitized API/config/storage wrappers; never print objects or stack traces.
  process.stderr.write(`${JSON.stringify({ event: 'fatal', error: error.message })}\n`);
  process.exitCode = 1;
});
