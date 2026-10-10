import { appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { MailTmClient, MailTmError } from '../src/mail/mailtm.js';

const AUTHORIZATION_PHRASE = 'AUTHORIZE ONE MAILTM TEST MAILBOX';
const mode = process.env.MAILTM_MODE ?? 'diagnostic';

async function writeReport(report) {
  const serialized = JSON.stringify(report, null, 2);
  process.stdout.write(`${serialized}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n## Mail.tm ${mode}\n\n\`\`\`json\n${serialized}\n\`\`\`\n`);
  }
}

function safeError(error) {
  return {
    kind: error instanceof MailTmError ? error.kind : 'unexpected',
    httpStatus: error instanceof MailTmError ? error.status : null,
    message: error instanceof Error ? error.message : 'Unknown failure',
    ...(error instanceof MailTmError && error.diagnostics ? { diagnostics: error.diagnostics } : {}),
  };
}

if (!['diagnostic', 'mailbox-test'].includes(mode)) {
  throw new Error('MAILTM_MODE must be diagnostic or mailbox-test.');
}
if (mode === 'mailbox-test'
  && (process.env.MAILTM_MAILBOX_AUTHORIZED !== 'true' || process.env.MAILTM_CONFIRMATION !== AUTHORIZATION_PHRASE)) {
  throw new Error('Mailbox integration requires its separate workflow authorization checkbox and confirmation phrase.');
}
if (mode === 'mailbox-test' && process.env.GITHUB_RUN_ATTEMPT && process.env.GITHUB_RUN_ATTEMPT !== '1') {
  throw new Error('A Mail.tm mailbox test cannot be repeated by rerunning the same workflow execution.');
}

const client = new MailTmClient({ retries: 2, retryDelayMs: 500, timeoutMs: 10_000 });
let domainInspection;
try {
  domainInspection = await client.inspectDomains();
} catch (error) {
  await writeReport({ mode, status: 'failed', usableDomainCount: null, error: safeError(error) });
  process.exitCode = 1;
}

if (domainInspection) {
  await writeReport({ mode: 'diagnostic', status: 'completed', ...domainInspection.diagnostics });
  if (mode === 'mailbox-test') {
    if (domainInspection.domains.length === 0) {
      await writeReport({ mode, status: 'skipped', reason: domainInspection.diagnostics.reason, mailboxCreated: false });
      process.exitCode = 1;
    } else {
      const username = `tmtest${randomBytes(7).toString('hex')}`;
      const password = `${randomBytes(32).toString('base64url')}A7!`;
      let mailbox;
      let result = { mode, status: 'failed', mailboxCreationOutcome: 'not_attempted', mailboxCreated: false, authenticationSucceeded: false, inboxRead: false, initiallyEmpty: null, cleanupAttempted: false, cleanupSucceeded: false };
      let failure;
      try {
        const address = `${username}@${domainInspection.domains[0]}`;
        result.mailboxCreationOutcome = 'attempted';
        const createdAccount = await client.createAccount({ address, password });
        mailbox = { accountId: createdAccount.id, address, password, token: null };
        result.mailboxCreationOutcome = 'created';
        result.mailboxCreated = true;
        mailbox.token = await client.authenticateMailbox({ address, password });
        const authenticatedAccount = await client.getMe(mailbox.token);
        if (authenticatedAccount?.id !== mailbox.accountId || authenticatedAccount?.address?.toLowerCase() !== mailbox.address.toLowerCase()) {
          throw new MailTmError('account verification', 'GET /me did not match the newly created account', null, { kind: 'account_mismatch' });
        }
        result.authenticationSucceeded = true;
        const messages = await client.getInbox(mailbox.token);
        result.inboxRead = true;
        result.initialInboxMessageCount = messages.length;
        result.initiallyEmpty = messages.length === 0;
        if (messages.length > 0) {
          const fullMessage = await client.getMessage(mailbox.token, messages[0].id);
          result.messageDetailsRead = fullMessage.id === messages[0].id;
          result.messageMetadataValidated = typeof fullMessage.createdAt === 'string'
            && typeof fullMessage.from?.address === 'string';
        }
        if (messages.length !== 0) throw new MailTmError('inbox verification', 'a newly created test inbox was not empty', null, { kind: 'unexpected_inbox_contents' });
        result.status = 'passed';
      } catch (error) {
        if (error?.accountCreationOutcome) {
          result.mailboxCreationOutcome = error.accountCreationOutcome;
          if (error.accountCreationOutcome === 'unknown') result.mailboxCreated = null;
        }
        failure = safeError(error);
      } finally {
        if (mailbox?.accountId) {
          if (mailbox.token) {
            result.cleanupAttempted = true;
            try {
              await client.deleteMailbox(mailbox.token, mailbox.accountId);
              result.cleanupSucceeded = true;
            } catch (error) {
              result.cleanupError = safeError(error);
              failure ??= { kind: 'cleanup_failed', message: 'The Mail.tm test mailbox could not be deleted.' };
            }
          } else {
            result.cleanupUnavailable = true;
            failure ??= { kind: 'cleanup_unavailable', message: 'The account was created but authentication failed before cleanup was possible.' };
          }
        } else if (result.mailboxCreationOutcome === 'unknown') {
          result.cleanupUnavailable = true;
        }
      }
      if (failure) {
        result.status = 'failed';
        result.error = failure;
      }
      await writeReport(result);
      if (result.status !== 'passed' || !result.cleanupSucceeded) process.exitCode = 1;
    }
  }
}
