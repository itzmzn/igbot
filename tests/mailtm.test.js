import test from 'node:test';
import assert from 'node:assert/strict';
import { MailTmClient, MailTmError } from '../src/mail/mailtm.js';

function jsonResponse(payload, status = 200, headers = { 'content-type': 'application/ld+json' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => status === 204 ? '' : JSON.stringify(payload),
  };
}

function collection(members, totalItems = members.length, next = false) {
  return {
    'hydra:member': members,
    'hydra:totalItems': totalItems,
    'hydra:view': { 'hydra:next': next ? '/domains?page=2' : '' },
  };
}

function clientOptions(options = {}) {
  return { minRequestIntervalMs: 0, retries: 0, sleep: async () => {}, ...options };
}

test('discovers only active public domains and completes mailbox authentication, /me, inbox, message retrieval, and cleanup', async () => {
  const calls = [];
  const messages = [{
    id: 'message-id',
    from: { name: 'Test Sender', address: 'sender@example.test' },
    createdAt: '2026-10-11T00:00:00.000Z',
    intro: 'Synthetic message',
  }];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/domains?page=1')) return jsonResponse(collection([
      { domain: 'inactive.test', isActive: false, isPrivate: false },
      { domain: 'private.test', isActive: true, isPrivate: true },
      { domain: 'mail.test', isActive: true, isPrivate: false },
    ]));
    if (url.endsWith('/accounts') && options.method === 'POST') return jsonResponse({ id: 'account-id' }, 201);
    if (url.endsWith('/token')) return jsonResponse({ id: 'account-id', token: 'mock-token-value-that-is-long' });
    if (url.endsWith('/me')) return jsonResponse({ id: 'account-id', address: 'igbotuser@mail.test' });
    if (url.endsWith('/messages?page=1')) return jsonResponse(collection(messages));
    if (url.endsWith('/messages/message-id')) return jsonResponse({ ...messages[0], text: 'Synthetic message body' });
    if (url.endsWith('/accounts/account-id') && options.method === 'DELETE') return jsonResponse(null, 204);
    throw new Error('Unexpected mock request');
  };
  const client = new MailTmClient(clientOptions({ fetchImpl }));
  const mailbox = await client.createMailbox({ username: 'igbotuser', password: 'mock-mailbox-password-1234' });
  assert.equal(mailbox.address, 'igbotuser@mail.test');
  assert.equal(mailbox.accountId, 'account-id');
  assert.equal(mailbox.token, 'mock-token-value-that-is-long');
  assert.equal((await client.getMe(mailbox.token)).address, mailbox.address);
  const inbox = await client.getInbox(mailbox.token);
  assert.equal(inbox[0].id, 'message-id');
  assert.equal(inbox[0].from.address, 'sender@example.test');
  assert.equal(inbox[0].createdAt, '2026-10-11T00:00:00.000Z');
  assert.equal((await client.getMessage(mailbox.token, 'message-id')).text, 'Synthetic message body');
  assert.equal(await client.deleteMailbox(mailbox.token, mailbox.accountId), null);
  assert.equal(calls.length, 7);
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.match(calls[2].options.headers.accept, /application\/ld\+json/);
  assert.equal(calls[3].options.headers.authorization, `Bearer ${mailbox.token}`);
  assert.equal(calls[6].options.method, 'DELETE');
});

test('reports an empty collection distinctly and refuses mailbox creation', async () => {
  const client = new MailTmClient(clientOptions({ fetchImpl: async () => jsonResponse(collection([], 0)) }));
  const result = await client.inspectDomains();
  assert.deepEqual(result.domains, []);
  assert.equal(result.diagnostics.totalDomainCount, 0);
  assert.equal(result.diagnostics.reason, 'no_domains_returned');
  assert.equal(result.diagnostics.httpStatus, 200);
  await assert.rejects(client.createMailbox({ username: 'igbotuser', password: 'long-enough-mailbox-password' }), (error) => {
    assert.equal(error.kind, 'no_usable_domains');
    return true;
  });
});

test('reports domains that exist but are all inactive or private', async () => {
  const client = new MailTmClient(clientOptions({ fetchImpl: async () => jsonResponse(collection([
    { domain: 'inactive.test', isActive: false, isPrivate: false },
    { domain: 'private.test', isActive: true, isPrivate: true },
  ])) }));
  const result = await client.inspectDomains();
  assert.deepEqual(result.domains, []);
  assert.equal(result.diagnostics.totalDomainCount, 2);
  assert.equal(result.diagnostics.activePrivateDomainCount, 1);
  assert.equal(result.diagnostics.inactiveDomainCount, 1);
  assert.equal(result.diagnostics.reason, 'domains_exist_but_none_are_active_public');
});

test('follows documented domain pagination and reports the aggregate count', async () => {
  const urls = [];
  const pageOne = Array.from({ length: 30 }, (_, index) => ({ domain: `d${index}.test`, isActive: true, isPrivate: false }));
  const client = new MailTmClient(clientOptions({ fetchImpl: async (url) => {
    urls.push(url);
    return url.endsWith('page=1')
      ? jsonResponse(collection(pageOne, 31, true))
      : jsonResponse(collection([{ domain: 'last.test', isActive: true, isPrivate: false }], 31));
  } }));
  const result = await client.inspectDomains();
  assert.equal(result.domains.length, 31);
  assert.equal(result.diagnostics.pagination.pagesFetched, 2);
  assert.equal(result.diagnostics.pagination.paginationComplete, true);
  assert.equal(urls[0].endsWith('/domains?page=1'), true);
  assert.equal(urls[1].endsWith('/domains?page=2'), true);
});

test('rejects malformed JSON and unexpected domain schemas instead of treating them as empty lists', async () => {
  const invalidJson = new MailTmClient(clientOptions({ fetchImpl: async () => ({
    ok: true, status: 200, headers: { get: () => 'application/ld+json' }, text: async () => '{',
  }) }));
  await assert.rejects(invalidJson.inspectDomains(), (error) => error.kind === 'malformed_json' && error.status === 200);

  const wrongSchema = new MailTmClient(clientOptions({ fetchImpl: async () => jsonResponse({ member: [] }) }));
  await assert.rejects(wrongSchema.inspectDomains(), (error) => error.kind === 'schema' && /hydra:member/.test(error.message));

  const invalidDomain = new MailTmClient(clientOptions({ fetchImpl: async () => jsonResponse(collection([{ domain: 'missing-flags.test' }])) }));
  await assert.rejects(invalidDomain.inspectDomains(), (error) => error.kind === 'schema' && /isActive/.test(error.message));
});

test('classifies request timeouts and DNS/TLS failures without exposing request secrets', async () => {
  const timeoutClient = new MailTmClient(clientOptions({ timeoutMs: 2, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }));
  await assert.rejects(timeoutClient.request('diagnostic', '/domains'), (error) => error.kind === 'timeout');

  for (const [code, kind] of [['ENOTFOUND', 'dns'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls']]) {
    const fetchImpl = async () => { const error = new TypeError('fetch failed'); error.cause = { code }; throw error; };
    const networkClient = new MailTmClient(clientOptions({ fetchImpl }));
    await assert.rejects(networkClient.request('diagnostic', '/domains', { token: 'private-token' }), (error) => {
      assert.equal(error.kind, kind);
      assert.equal(error.message.includes('private-token'), false);
      return true;
    });
  }
});

test('does not retry authentication or validation errors and reports their status clearly', async () => {
  for (const [status, kind, operation] of [[401, 'authentication', 'authentication'], [403, 'authentication', 'authorization'], [422, 'validation', 'payload']]) {
    let calls = 0;
    const client = new MailTmClient(clientOptions({ retries: 4, fetchImpl: async () => { calls += 1; return jsonResponse({ secret: 'must-not-leak' }, status); } }));
    await assert.rejects(client.request('test', '/test'), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.kind, kind);
      assert.equal(error.message.includes('must-not-leak'), false);
      assert.match(error.message, new RegExp(operation === 'payload' ? 'payload' : operation));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('does not repeat a non-idempotent account creation request after an ambiguous server error', async () => {
  let calls = 0;
  const client = new MailTmClient(clientOptions({ retries: 4, fetchImpl: async () => {
    calls += 1;
    return jsonResponse({ detail: 'not logged' }, 503);
  } }));
  await assert.rejects(client.createAccount({ address: 'tmtest@example.test', password: 'secure-test-password-123456' }), (error) => {
    assert.equal(error.kind, 'server');
    assert.equal(error.accountCreationOutcome, 'unknown');
    return true;
  });
  assert.equal(calls, 1);
});

test('retries HTTP 429 with bounded exponential backoff and honors Retry-After', async () => {
  const delays = [];
  let calls = 0;
  const client = new MailTmClient(clientOptions({
    retries: 2,
    retryDelayMs: 3,
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls < 3
        ? jsonResponse({ password: 'secret' }, 429, { 'content-type': 'application/json', 'retry-after': '0' })
        : jsonResponse(collection([], 0));
    },
  }));
  assert.deepEqual(await client.discoverDomains(), []);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test('retries transient server errors only a bounded number of times', async () => {
  let calls = 0;
  const client = new MailTmClient(clientOptions({ retries: 2, retryDelayMs: 1, fetchImpl: async () => {
    calls += 1;
    return jsonResponse({ token: 'must-not-leak' }, 503);
  } }));
  await assert.rejects(client.request('test', '/test', { token: 'secret-token' }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.kind, 'server');
    assert.equal(error.message.includes('secret-token'), false);
    return true;
  });
  assert.equal(calls, 3);
});

test('spaces requests to respect the configured per-client rate', async () => {
  let clock = 0;
  const starts = [];
  const client = new MailTmClient(clientOptions({
    minRequestIntervalMs: 125,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async () => { starts.push(clock); return jsonResponse({ ok: true }); },
  }));
  await client.request('rate test', '/one');
  await client.request('rate test', '/two');
  assert.deepEqual(starts, [0, 125]);
});

test('authenticates inbox requests, fetches all message pages, and supports message polling', async () => {
  const headers = [];
  let pollCount = 0;
  const pageOne = Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, createdAt: '2026-10-11T00:00:00.000Z', from: { address: 'synthetic@example.test' } }));
  const client = new MailTmClient(clientOptions({ fetchImpl: async (url, options) => {
    headers.push(options.headers.authorization);
    if (url.endsWith('messages?page=1') && pollCount === 0) return jsonResponse(collection(pageOne, 31, true));
    if (url.endsWith('messages?page=2') && pollCount === 0) {
      pollCount += 1;
      return jsonResponse(collection([{ id: 'm30', createdAt: '2026-10-11T00:00:00.000Z', from: { address: 'synthetic@example.test' } }], 31));
    }
    if (url.endsWith('messages?page=1') && pollCount === 1) {
      pollCount += 1;
      return jsonResponse(collection([], 0));
    }
    return jsonResponse(collection([{ id: 'arrived', createdAt: '2026-10-11T00:01:00.000Z', from: { address: 'synthetic@example.test' } }], 1));
  } }));
  const inbox = await client.getInbox('mock-bearer-token-long');
  assert.equal(inbox.length, 31);
  assert.equal(inbox[30].id, 'm30');
  assert.ok(headers.every((value) => value === 'Bearer mock-bearer-token-long'));
  const polled = await client.pollInbox('mock-bearer-token-long', { maxAttempts: 2, intervalMs: 0 });
  assert.equal(polled.messages[0].id, 'arrived');
  assert.equal(polled.attempts, 2);
  assert.equal(polled.timedOut, false);
});

test('polling observes the overall deadline and supports cancellation', async () => {
  let clock = 0;
  const timeoutClient = new MailTmClient(clientOptions({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async () => jsonResponse(collection([], 0)),
  }));
  const result = await timeoutClient.pollInbox('mock-token-value-long', { maxAttempts: 10, intervalMs: 100, timeoutMs: 250 });
  assert.equal(result.attempts, 3);
  assert.equal(result.timedOut, true);

  const controller = new AbortController();
  const cancelClient = new MailTmClient(clientOptions({
    sleep: async () => { controller.abort(); },
    fetchImpl: async () => jsonResponse(collection([], 0)),
  }));
  await assert.rejects(cancelClient.pollInbox('mock-token-value-long', {
    maxAttempts: 3, intervalMs: 1, timeoutMs: 1000, signal: controller.signal,
  }), (error) => error.kind === 'cancelled');
});

test('inbox and message schema failures are reported instead of hidden', async () => {
  const inboxClient = new MailTmClient(clientOptions({ fetchImpl: async () => jsonResponse({ 'hydra:member': [], 'hydra:totalItems': '0' }) }));
  await assert.rejects(inboxClient.getInbox('mock-token-value-long'), (error) => error.kind === 'schema');
  const messageClient = new MailTmClient(clientOptions({ fetchImpl: async () => jsonResponse({ unexpected: true }) }));
  await assert.rejects(messageClient.getMessage('mock-token-value-long', 'id'), (error) => error.kind === 'schema');
});
