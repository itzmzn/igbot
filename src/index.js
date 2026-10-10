import path from 'node:path';
import { createConfig, INSTAGRAM_SIGNUP_URL } from './config.js';
import { launchChromium } from './browser/chromium.js';
import { generateUsername, generateUsernameWithNumericSuffix } from './generators/username.js';
import { generatePassword } from './generators/password.js';
import { generateRandomBirthday } from './generators/birthday.js';
import { MailTmClient } from './mail/mailtm.js';
import { runSignup } from './instagram/signup.js';
import { manualVerificationInstructions } from './instagram/verification.js';
import { saveAccount, saveEncryptedCredentials, verifyEncryptedStorage } from './storage/account.js';

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
  // Verify protected storage before creating a mailbox or contacting Instagram.
  const accountsDirectory = path.resolve('accounts');
  await verifyEncryptedStorage(config.encryptionKey, accountsDirectory);

  const usernameCandidates = [];
  for (let attempt = 0; attempt < 6 && usernameCandidates.length < 3; attempt += 1) {
    const candidate = generateUsernameWithNumericSuffix(config.usernamePrefix);
    if (!usernameCandidates.includes(candidate)) usernameCandidates.push(candidate);
  }
  if (usernameCandidates.length !== 3) throw new Error('Could not generate distinct username candidates within the configured limit.');
  let username = usernameCandidates[0];
  const password = generatePassword();
  const mailPassword = generatePassword();
  const mailboxClient = new MailTmClient();
  const browser = await launchChromium();
  let mailbox = null;
  let result;
  let diagnostics;
  let submitAttempted = false;
  let submittedAt = null;
  const credentials = () => ({
    username,
    password,
    email: mailbox.address,
    mailboxPassword: mailPassword,
    ...(submittedAt ? { submittedAt } : {}),
  });
  try {
    mailbox = await mailboxClient.createMailbox({ username: `${username}mail`, password: mailPassword });
    emit('mailbox_created', { status: 'ready' });

    const page = await browser.newPage();
    diagnostics = safeNetworkDiagnostics(page);
    result = await runSignup(page, {
      email: mailbox.address,
      fullName: config.fullName,
      username,
      usernameCandidates,
      onUsernameSelected: (selected) => { username = selected; },
      password,
      dateOfBirth: config.dateOfBirth,
      url: INSTAGRAM_SIGNUP_URL,
      authorized: true,
      navigate: true,
      onSubmitted: (timestamp) => { submitAttempted = true; submittedAt = timestamp; },
    });
    submitAttempted = result.submitAttempted;
    username = result.username ?? username;

    if (result.status === 'challenge' && !result.submitAttempted) {
      emit('registration_stopped', { status: 'security_challenge', submitAttempted: false, reason: result.reason });
      process.exitCode = 2;
      return;
    }
    if (result.status === 'rejected' && !result.submitAttempted) {
      emit('registration_stopped', { status: 'rejected', submitAttempted: false, username, reason: result.reason });
      process.exitCode = 2;
      return;
    }

    let messageAvailable = false;
    if (result.status === 'verification_required') {
      try {
        const inbox = await mailboxClient.pollInbox(mailbox.token, {
          maxAttempts: config.mailPollMaxAttempts,
          intervalMs: config.mailPollIntervalMs,
        });
        messageAvailable = inbox.messages.length > 0;
      } catch (error) {
        emit('mailbox_poll_failed', { kind: error.kind ?? 'mail_api', status: error.status ?? null });
      }
      emit('manual_verification_required', {
        status: 'awaiting_manual_verification',
        username,
        messageAvailable,
        instructions: manualVerificationInstructions(result.status),
      });
    } else if (result.status === 'challenge') {
      emit('manual_verification_required', {
        status: 'security_challenge',
        username,
        instructions: manualVerificationInstructions(result.status),
      });
    } else if (result.status === 'rejected') {
      emit('registration_rejected', { status: 'rejected', username, reason: result.reason });
    } else if (result.status === 'unknown') {
      emit('registration_unconfirmed', { status: 'registration_unconfirmed', username });
    } else {
      emit('registration_confirmed', { status: 'confirmed', username });
    }

    const status = result.status === 'confirmed' ? 'confirmed'
      : result.status === 'verification_required' ? 'awaiting_manual_verification'
        : result.status === 'challenge' ? 'security_challenge'
          : result.status === 'rejected' ? 'rejected' : 'registration_unconfirmed';
    if (status === 'confirmed') {
      const stored = await saveAccount({
        username,
        email: mailbox.address,
        status,
        encryptionKey: config.encryptionKey,
        credentials: credentials(),
        directory: accountsDirectory,
        createdAt: result.submittedAt,
      });
      emit('account_artifact_prepared', {
        status,
        username,
        metadataPath: path.relative(process.cwd(), stored.metadataPath),
        encryptedCredentialsPath: path.relative(process.cwd(), stored.credentialPath),
      });
    } else {
      const stored = await saveEncryptedCredentials({
        username,
        credentials: credentials(),
        encryptionKey: config.encryptionKey,
        directory: accountsDirectory,
      });
      emit('registration_not_confirmed', {
        status,
        username,
        encryptedCredentialsPath: path.relative(process.cwd(), stored.credentialPath),
      });
    }
    emit('browser_diagnostics', {
      consoleErrorCount: diagnostics.consoleErrors.length,
      networkFailureCount: diagnostics.networkFailures.length,
    });
    if (status !== 'confirmed') process.exitCode = 2;
  } catch (error) {
    if (submitAttempted && mailbox) {
      try {
        const stored = await saveEncryptedCredentials({
          username,
          credentials: credentials(),
          encryptionKey: config.encryptionKey,
          directory: accountsDirectory,
        });
        emit('registration_outcome_uncertain', {
          status: 'registration_unconfirmed',
          encryptedCredentialsPath: path.relative(process.cwd(), stored.credentialPath),
        });
      } catch {
        throw new Error('Registration was submitted but its outcome or protected credential persistence could not be confirmed. Do not repeat the attempt.');
      }
    }
    throw error;
  } finally {
    await browser.close().catch(() => emit('browser_cleanup', { status: 'failed' }));
    if (!submitAttempted && mailbox) {
      try {
        await mailboxClient.deleteMailbox(mailbox.token, mailbox.accountId);
        emit('mailbox_cleanup', { status: 'deleted' });
      } catch (error) {
        emit('mailbox_cleanup', { status: 'failed', kind: error.kind ?? 'mail_api', httpStatus: error.status ?? null });
      }
    }
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
