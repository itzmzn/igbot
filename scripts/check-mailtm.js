import { MailTmClient } from '../src/mail/mailtm.js';

try {
  const domains = await new MailTmClient({ retries: 1, retryDelayMs: 250 }).discoverDomains();
  if (domains.length === 0) throw new Error('Mail.tm returned no active public domains.');
  const summary = `Mail.tm domain discovery: available (${domains.length} active public domain(s)); no mailbox was created.\n`;
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n- ${summary.trim()}\n`);
  }
} catch (error) {
  const summary = `Mail.tm domain discovery unavailable: ${error.message}; no mailbox was created.\n`;
  process.stderr.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n- ${summary.trim()}\n`);
  }
  process.exitCode = 1;
}
