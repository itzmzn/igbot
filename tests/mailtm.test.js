import test from 'node:test';
import assert from 'node:assert/strict';
import { MailTmClient, MailTmError } from '../src/mail/mailtm.js';

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('Mail.tm discovers domains, creates a mailbox, authenticates, polls, and retrieves messages', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/domains?page=1')) return jsonResponse({ 'hydra:member': [
      { domain: 'inactive.test', isActive: false },
      { domain: 'private.test', isPrivate: true },
      { domain: 'mail.test', isActive: true, isPrivate: false },
    ] });
    if (url.endsWith('/accounts')) return jsonResponse({ id: 'account-id' }, 201);
    if (url.endsWith('/token')) return jsonResponse({ token: 'mock-token-value-that-is-long' });
    if (url.endsWith('/messages?page=1')) return jsonResponse({ 'hydra:member': [{ id: 'message-id' }] });
    if (url.endsWith('/messages/message-id')) return jsonResponse({ id: 'message-id', intro: 'Mock only' });
    throw new Error('Unexpected mock request');
  };
  const client = new MailTmClient({ fetchImpl, retries: 0, sleep: async () => {} });
  const domains = await client.discoverDomains();
  assert.deepEqual(domains, ['mail.test']);
  const mailbox = await client.createMailbox({ username: 'igbotuser', password: 'mock-mailbox-password-1234' });
  assert.equal(mailbox.address, 'igbotuser@mail.test');
  assert.equal(mailbox.token, 'mock-token-value-that-is-long');
  const inbox = await client.pollInbox(mailbox.token, { maxAttempts: 2, intervalMs: 0 });
  assert.equal(inbox.messages[0].id, 'message-id');
  const message = await client.getMessage(mailbox.token, 'message-id');
  assert.equal(message.intro, 'Mock only');
  assert.equal(calls.length, 6);
  assert.match(calls[4].options.headers.authorization, /^Bearer mock-token/);
  assert.equal(calls[0].options.headers.authorization, undefined);
});


test('domain discovery falls back to the bare collection when the paged response is empty', async () => {
  const urls = [];
  const client = new MailTmClient({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('/domains?page=1')) return jsonResponse({ 'hydra:member': [], 'hydra:totalItems': 0 });
      return jsonResponse({ 'hydra:member': [{ domain: 'fallback.test', isActive: true, isPrivate: false }] });
    },
    retries: 0,
  });
  assert.deepEqual(await client.discoverDomains(), ['fallback.test']);
  assert.equal(urls.length, 2);
  assert.ok(urls[1].endsWith('/domains'));
});

test('Mail.tm retries transient responses a bounded number of times and does not expose response bodies', async () => {
  let calls = 0;
  const secret = 'never-log-this-token';
  const client = new MailTmClient({
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503, json: async () => ({ token: secret, password: secret }) };
    },
    retries: 2,
    retryDelayMs: 1,
    sleep: async () => {},
  });
  await assert.rejects(client.request('test operation', '/test', { token: secret }), (error) => {
    assert.ok(error instanceof MailTmError);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(calls, 3);
});

test('Mail.tm does not retry permanent client errors and reports a generic error', async () => {
  let calls = 0;
  const client = new MailTmClient({
    fetchImpl: async () => { calls += 1; return { ok: false, status: 401, json: async () => ({ detail: 'sensitive' }) }; },
    retries: 4,
    sleep: async () => {},
  });
  await assert.rejects(client.getInbox('secret-token'), /HTTP 401/);
  assert.equal(calls, 1);
});

test('inbox polling stops after its configured maximum', async () => {
  let calls = 0;
  const client = new MailTmClient({
    fetchImpl: async () => { calls += 1; return jsonResponse({ 'hydra:member': [] }); },
    retries: 0,
    sleep: async () => {},
  });
  const result = await client.pollInbox('mock-token-value-long', { maxAttempts: 3, intervalMs: 0 });
  assert.deepEqual(result, { messages: [], attempts: 3, timedOut: true });
  assert.equal(calls, 3);
});
