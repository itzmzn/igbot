import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConfig, INSTAGRAM_SIGNUP_URL } from './config.js';
import { launchChromium } from './browser/chromium.js';
import { generateUsername, generateUsernameWithNumericSuffix } from './generators/username.js';
import { generatePassword } from './generators/password.js';
import { generateRandomBirthday } from './generators/birthday.js';
import { MailTmClient } from './mail/mailtm.js';
import { runSignup } from './instagram/signup.js';
import { INSTAGRAM_LOGIN_URL, runLogin } from './instagram/login.js';
import { collectPageDiagnostics, manualVerificationInstructions, safeInstagramRoute } from './instagram/verification.js';
import { saveAccount, saveEncryptedCredentials, verifyEncryptedStorage } from './storage/account.js';

function emit(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function safeNetworkDiagnostics(page) {
  const diagnostics = { consoleErrors: [], networkFailures: [], dialogTypes: [], urlChanges: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push({ type: 'console_error' });
  });
  page.on('requestfailed', (request) => {
    let host = 'unknown';
    try { host = new URL(request.url()).hostname; } catch { /* omit malformed URL */ }
    diagnostics.networkFailures.push({ host, type: 'request_failed' });
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const route = safeInstagramRoute(frame.url());
    if (diagnostics.urlChanges.at(-1) !== route && diagnostics.urlChanges.length < 20) diagnostics.urlChanges.push(route);
  });
  page.on('dialog', async (dialog) => {
    diagnostics.dialogTypes.push(dialog.type());
    await dialog.dismiss().catch(() => {});
  });
  return diagnostics;
}

async function saveSanitizedDiagnostics({ phase, page, events, result }) {
  const pageDiagnostics = await collectPageDiagnostics(page, { urlChanges: events.urlChanges, afterSubmit: result?.submitAttempted === true });
  const report = {
    schemaVersion: 1,
    phase,
    result: {
      status: result?.status ?? 'unknown',
      reason: result?.reason ?? 'automation_error',
      submitAttempted: result?.submitAttempted === true,
    },
    selectors: Array.isArray(result?.diagnostics) ? result.diagnostics : [],
    page: pageDiagnostics,
    browser: {
      consoleErrorCount: events.consoleErrors.length,
      networkFailureCount: events.networkFailures.length,
      networkFailureHosts: [...new Set(events.networkFailures.map((item) => item.host))].slice(0, 20),
      dialogTypes: [...events.dialogTypes],
    },
  };
  const directory = path.resolve('diagnostics');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `${phase}.json`);
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return path.relative(process.cwd(), filePath);
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
    if (!usernameCandidates.includes(candidate) && !config.excludedUsernames.includes(candidate.toLowerCase())) usernameCandidates.push(candidate);
  }
  if (usernameCandidates.length !== 3) throw new Error('Could not generate distinct username candidates within the configured limit.');
  let username = usernameCandidates[0];
  const password = generatePassword();
  const mailPassword = generatePassword();
  const mailboxClient = new MailTmClient();
  const browser = await launchChromium();
  let mailbox = null;
  let page = null;
  let pageEvents = null;
  let loginContext = null;
  let loginPage = null;
  let loginEvents = null;
  let result;
  let loginResult;
  let submitAttempted = false;
  let submittedAt = null;
  let credentialPersisted = false;
  const credentials = () => ({
    username,
    password,
    email: mailbox.address,
    mailboxPassword: mailPassword,
    ...(submittedAt ? { submittedAt } : {}),
  });
  const persistEncryptedCredentials = async () => {
    if (credentialPersisted || !submitAttempted || !mailbox) return null;
    const stored = await saveEncryptedCredentials({
      username,
      credentials: credentials(),
      encryptionKey: config.encryptionKey,
      directory: accountsDirectory,
    });
    credentialPersisted = true;
    return stored;
  };
  try {
    page = await browser.newPage();
    pageEvents = safeNetworkDiagnostics(page);
    result = await runSignup(page, {
      email: '',
      fullName: config.fullName,
      username,
      usernameCandidates,
      onUsernameSelected: async (selected) => {
        username = selected;
        mailbox = await mailboxClient.createMailbox({ username: `${selected}mail`, password: mailPassword });
        emit('mailbox_created', { status: 'ready' });
        return { email: mailbox.address };
      },
      password,
      dateOfBirth: config.dateOfBirth,
      url: INSTAGRAM_SIGNUP_URL,
      authorized: true,
      navigate: true,
      hasUnexpectedDialogs: () => pageEvents.dialogTypes.length > 0,
      onSubmitted: (timestamp) => { submitAttempted = true; submittedAt = timestamp; },
    });
    submitAttempted = result.submitAttempted;
    username = result.username ?? username;
    if (result.status === 'confirmed' && !submitAttempted) {
      result = { status: 'unknown', reason: 'success_state_without_signup_submission', submitAttempted: false, username };
    }

    emit('signup_outcome', {
      status: result.status,
      reason: result.reason,
      submitAttempted,
      username,
    });

    if (result.status !== 'confirmed') {
      let messageAvailable = false;
      if (result.status === 'verification_required' && mailbox?.token) {
        try {
          const inbox = await mailboxClient.pollInbox(mailbox.token, {
            maxAttempts: config.mailPollMaxAttempts,
            intervalMs: config.mailPollIntervalMs,
          });
          messageAvailable = inbox.messages.length > 0;
        } catch (error) {
          emit('mailbox_poll_failed', { kind: error.kind ?? 'mail_api', status: error.status ?? null });
        }
      }
      if (result.status === 'verification_required' || result.status === 'challenge' || result.status === 'birthday_confirmation') {
        emit('manual_verification_required', {
          status: 'pending_verification',
          username,
          messageAvailable,
          instructions: manualVerificationInstructions(result.status),
        });
      } else if (result.status === 'rejected' || result.status === 'validation_error') {
        emit('registration_rejected', { status: 'rejected', username, reason: result.reason });
      } else {
        emit('registration_unconfirmed', { status: 'registration_unconfirmed', username, reason: result.reason });
      }
      if (page && pageEvents) {
        const diagnosticPath = await saveSanitizedDiagnostics({ phase: 'signup', page, events: pageEvents, result });
        emit('sanitized_diagnostics_saved', { path: diagnosticPath });
      }
      if (submitAttempted) {
        const stored = await persistEncryptedCredentials();
        if (stored) emit('encrypted_credentials_saved', { path: path.relative(process.cwd(), stored.credentialPath) });
      }
      emit('browser_diagnostics', {
        consoleErrorCount: pageEvents.consoleErrors.length,
        networkFailureCount: pageEvents.networkFailures.length,
        dialogCount: pageEvents.dialogTypes.length,
        urlRoutes: pageEvents.urlChanges,
      });
      process.exitCode = 2;
      return;
    }

    // A fresh context forces an actual login with the generated credentials and is discarded afterward.
    loginContext = await browser.newContext();
    loginPage = await loginContext.newPage();
    loginEvents = safeNetworkDiagnostics(loginPage);
    loginResult = await runLogin(loginPage, {
      username,
      password,
      authorized: true,
      url: INSTAGRAM_LOGIN_URL,
      navigate: true,
    });
    emit('login_outcome', { status: loginResult.status, reason: loginResult.reason, submitAttempted: loginResult.submitAttempted, username });
    if (loginResult.status !== 'authenticated') {
      const diagnosticPath = await saveSanitizedDiagnostics({ phase: 'login', page: loginPage, events: loginEvents, result: loginResult });
      emit('sanitized_diagnostics_saved', { path: diagnosticPath });
      const stored = await persistEncryptedCredentials();
      if (stored) emit('encrypted_credentials_saved', { path: path.relative(process.cwd(), stored.credentialPath) });
      if (loginResult.status === 'challenge' || loginResult.status === 'verification_required') {
        emit('manual_verification_required', {
          status: 'pending_verification',
          username,
          instructions: manualVerificationInstructions(loginResult.status),
        });
      }
      process.exitCode = 2;
      return;
    }

    const stored = await saveAccount({
      username,
      email: mailbox.address,
      status: 'confirmed',
      encryptionKey: config.encryptionKey,
      credentials: credentials(),
      directory: accountsDirectory,
      createdAt: result.submittedAt,
    });
    credentialPersisted = true;
    emit('account_confirmed', {
      status: 'confirmed',
      username,
      registrationStatus: 'confirmed',
      loginStatus: 'authenticated',
      metadataPath: path.relative(process.cwd(), stored.metadataPath),
      encryptedCredentialsPath: path.relative(process.cwd(), stored.credentialPath),
    });
    emit('browser_diagnostics', {
      consoleErrorCount: pageEvents.consoleErrors.length + loginEvents.consoleErrors.length,
      networkFailureCount: pageEvents.networkFailures.length + loginEvents.networkFailures.length,
      dialogCount: pageEvents.dialogTypes.length + loginEvents.dialogTypes.length,
    });
  } catch (error) {
    if (submitAttempted && mailbox) {
      try { await persistEncryptedCredentials(); } catch {
        throw new Error('Registration was submitted but protected credential persistence failed. Do not repeat the attempt.');
      }
      if (page && pageEvents) {
        await saveSanitizedDiagnostics({ phase: 'signup', page, events: pageEvents, result: result ?? { status: 'unknown', reason: 'automation_error', submitAttempted: true } }).catch(() => {});
      }
      if (loginPage && loginEvents) {
        await saveSanitizedDiagnostics({ phase: 'login', page: loginPage, events: loginEvents, result: loginResult ?? { status: 'unknown', reason: 'automation_error', submitAttempted: false } }).catch(() => {});
      }
      emit('registration_outcome_uncertain', { status: 'registration_unconfirmed', username });
    }
    process.stderr.write(`${JSON.stringify({ event: 'fatal', error: error?.name === 'MailTmError' ? error.message : 'signup_or_login_automation_failed' })}\n`);
    process.exitCode = 1;
  } finally {
    await loginContext?.close().catch(() => emit('login_context_cleanup', { status: 'failed' }));
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
  // Do not emit dynamic form content, request URLs, credentials, or raw browser exceptions.
  process.stderr.write(`${JSON.stringify({ event: 'fatal', error: error?.name === 'MailTmError' ? error.message : 'automation_start_failed' })}\n`);
  process.exitCode = 1;
});
