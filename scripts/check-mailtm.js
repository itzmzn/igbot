import { appendFile } from 'node:fs/promises';
import { MailTmClient } from '../src/mail/mailtm.js';

async function addSummary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n- ${line}\n`);
}

try {
  const domains = await new MailTmClient({ retries: 1, retryDelayMs: 250 }).discoverDomains();
  if (domains.length === 0) {
    const summary = 'Mail.tm responded but returned no active public domains; no mailbox was created.';
    process.stderr.write(`::warning::${summary}\n`);
    await addSummary(summary);
  } else {
    const summary = `Mail.tm domain discovery is available (${domains.length} active public domain(s)); no mailbox was created.`;
    process.stdout.write(`${summary}\n`);
    await addSummary(summary);
  }
} catch (error) {
  const summary = `Mail.tm domain discovery is unavailable: ${error.message}; no mailbox was created.`;
  process.stderr.write(`::warning::${summary}\n`);
  await addSummary(summary);
}
