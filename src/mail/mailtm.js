const DEFAULT_BASE_URL = 'https://api.mail.tm';
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 125; // Mail.tm documents a limit of 8 requests/second/IP.
const PAGE_SIZE = 30; // Mail.tm documents up to 30 collection items per page.

export class MailTmError extends Error {
  constructor(operation, message, status = null, { kind = 'api', diagnostics = null } = {}) {
    super(`Mail.tm ${operation} failed${status ? ` (HTTP ${status})` : ''}: ${message}`);
    this.name = 'MailTmError';
    this.operation = operation;
    this.status = status;
    this.kind = kind;
    this.diagnostics = diagnostics;
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function classifyNetworkError(error, timedOut = false) {
  if (timedOut || error?.name === 'TimeoutError') return 'timeout';
  const code = String(error?.cause?.code ?? error?.code ?? '').toUpperCase();
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL'].includes(code)) return 'dns';
  if (code.startsWith('CERT_') || code.startsWith('ERR_TLS') || code.includes('CERTIFICATE') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'tls';
  return 'network';
}

function contentTypeOf(response) {
  try {
    return response.headers?.get?.('content-type') ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.min(30_000, Math.max(0, timestamp - Date.now())) : null;
}

function assertCollection(data, operation) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data['hydra:member'])) {
    throw new MailTmError(operation, 'unexpected response schema: expected a Hydra collection with hydra:member', null, { kind: 'schema' });
  }
  const totalItems = data['hydra:totalItems'];
  if (!Number.isSafeInteger(totalItems) || totalItems < 0) {
    throw new MailTmError(operation, 'unexpected response schema: hydra:totalItems must be a non-negative integer', null, { kind: 'schema' });
  }
  const view = data['hydra:view'];
  if (view !== undefined && (!view || typeof view !== 'object' || Array.isArray(view))) {
    throw new MailTmError(operation, 'unexpected response schema: hydra:view must be an object', null, { kind: 'schema' });
  }
  if (view && view['hydra:next'] !== undefined && typeof view['hydra:next'] !== 'string') {
    throw new MailTmError(operation, 'unexpected response schema: hydra:view.hydra:next must be a string', null, { kind: 'schema' });
  }
  return { members: data['hydra:member'], totalItems, hasNext: Boolean(view?.['hydra:next']) };
}

function schemaKeys(data) {
  return data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort() : [];
}

export class MailTmClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    retries = DEFAULT_RETRIES,
    retryDelayMs = 250,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    minRequestIntervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS,
    maxPages = 100,
    sleep = pause,
    now = Date.now,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new RangeError('Mail.tm retries must be between 0 and 5.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('Mail.tm timeout must be a positive number of milliseconds.');
    if (!Number.isFinite(minRequestIntervalMs) || minRequestIntervalMs < 0) throw new RangeError('Mail.tm request interval cannot be negative.');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new RangeError('Mail.tm maximum pages must be between 1 and 1000.');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.timeoutMs = timeoutMs;
    this.minRequestIntervalMs = minRequestIntervalMs;
    this.maxPages = maxPages;
    this.sleep = sleep;
    this.now = now;
    this.nextRequestAt = 0;
    this.rateLimitQueue = Promise.resolve();
  }

  async reserveRequestSlot() {
    let release;
    const previous = this.rateLimitQueue;
    this.rateLimitQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const delayMs = Math.max(0, this.nextRequestAt - this.now());
      if (delayMs > 0) await this.sleep(delayMs);
      this.nextRequestAt = this.now() + this.minRequestIntervalMs;
    } finally {
      release();
    }
  }

  async sleepOrCancel(ms, signal, operation) {
    if (signal?.aborted) throw new MailTmError(operation, 'operation was cancelled', null, { kind: 'cancelled' });
    if (!signal) return this.sleep(ms);
    let onAbort;
    try {
      await Promise.race([
        new Promise((_, reject) => {
          onAbort = () => reject(new MailTmError(operation, 'operation was cancelled', null, { kind: 'cancelled' }));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
        Promise.resolve().then(() => this.sleep(ms)),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async readJson(response, operation) {
    if (response.status === 204) return null;
    try {
      if (typeof response.text === 'function') {
        const text = await response.text();
        if (text.length === 0) throw new Error('empty response body');
        return JSON.parse(text);
      }
      return await response.json();
    } catch {
      throw new MailTmError(operation, 'the API returned malformed or empty JSON', response.status, {
        kind: 'malformed_json',
        diagnostics: { httpStatus: response.status, contentType: contentTypeOf(response) },
      });
    }
  }

  async request(operation, path, { method = 'GET', token, body, signal, timeoutMs = this.timeoutMs, deadline, metadata = false, retries = this.retries } = {}) {
    if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new RangeError('Mail.tm request retries must be between 0 and 5.');
    const url = `${this.baseUrl}${path}`;
    const startedAt = this.now();
    let lastHttpDiagnostics = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await this.reserveRequestSlot();
      const remainingMs = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - this.now());
      if (remainingMs <= 0) {
        throw new MailTmError(operation, 'the overall request deadline was reached', null, {
          kind: 'timeout',
          diagnostics: { durationMs: Math.max(0, this.now() - startedAt) },
        });
      }
      const timeoutController = new AbortController();
      const requestTimeoutMs = Math.max(1, Math.floor(remainingMs));
      let timeoutId;
      let abortHandler;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = new DOMException('The Mail.tm request timed out.', 'TimeoutError');
          timeoutController.abort(timeoutError);
          reject(timeoutError);
        }, requestTimeoutMs);
      });
      const cancellationPromise = signal ? new Promise((_, reject) => {
        abortHandler = () => reject(new DOMException('The Mail.tm request was cancelled.', 'AbortError'));
        if (signal.aborted) abortHandler();
        else signal.addEventListener('abort', abortHandler, { once: true });
      }) : null;
      const cleanupRequestTimers = () => {
        clearTimeout(timeoutId);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      };
      let response;
      let data;
      try {
        const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
        const requestPromise = (async () => {
          const fetched = await this.fetch(url, {
            method,
            headers: {
              accept: 'application/ld+json, application/json',
              ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: requestSignal,
          });
          return { response: fetched, data: fetched.ok ? await this.readJson(fetched, operation) : undefined };
        })();
        const raced = await Promise.race(cancellationPromise
          ? [requestPromise, timeoutPromise, cancellationPromise]
          : [requestPromise, timeoutPromise]);
        response = raced.response;
        data = raced.data;
      } catch (error) {
        cleanupRequestTimers();
        if (error instanceof MailTmError) {
          error.diagnostics = {
            ...(error.diagnostics ?? {}),
            httpStatus: error.status,
            contentType: error.diagnostics?.contentType ?? 'unknown',
            durationMs: Math.max(0, this.now() - startedAt),
          };
          throw error;
        }
        const kind = classifyNetworkError(error, timeoutController.signal.aborted);
        if (signal?.aborted) throw new MailTmError(operation, 'request was cancelled', null, { kind: 'cancelled' });
        if (deadline !== undefined && this.now() >= deadline) {
          throw new MailTmError(operation, 'the overall request deadline was reached', null, {
            kind: 'timeout',
            diagnostics: { networkClass: 'timeout', durationMs: Math.max(0, this.now() - startedAt) },
          });
        }
        if (attempt < retries) {
          const delayMs = Math.min(this.retryDelayMs * (2 ** attempt), deadline === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadline - this.now()));
          if (delayMs > 0) await this.sleepOrCancel(delayMs, signal, operation);
          continue;
        }
        throw new MailTmError(operation, `request failed ${retries > 0 ? 'after bounded retries' : 'without retry'} (${kind})`, null, {
          kind,
          diagnostics: { networkClass: kind, durationMs: Math.max(0, this.now() - startedAt) },
        });
      } finally {
        cleanupRequestTimers();
      }

      const contentType = contentTypeOf(response);
      lastHttpDiagnostics = {
        httpStatus: response.status,
        contentType,
        durationMs: Math.max(0, this.now() - startedAt),
      };
      if (response.ok) {
        if (data === undefined && response.status !== 204) throw new MailTmError(operation, 'the API response body was empty', response.status, { kind: 'malformed_json', diagnostics: lastHttpDiagnostics });
        return metadata ? { data, ...lastHttpDiagnostics } : data;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < retries) {
        const backoff = this.retryDelayMs * (2 ** attempt);
        const retryDelay = retryAfterMs(response) ?? backoff;
        const boundedDelay = response.status === 429 ? Math.max(1000, retryDelay) : retryDelay;
        const delayMs = Math.min(boundedDelay, deadline === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadline - this.now()));
        if (delayMs > 0) await this.sleepOrCancel(delayMs, signal, operation);
        continue;
      }
      const detail = response.status === 401 || response.status === 403
        ? 'authentication or authorization was rejected'
        : response.status === 422
          ? 'the API rejected the request payload'
          : response.status === 429
            ? 'the API rate limit was reached'
            : response.status >= 500
              ? 'the API returned a server error'
              : 'the API rejected the request';
      const kind = response.status === 401 || response.status === 403 ? 'authentication'
        : response.status === 422 ? 'validation'
          : response.status === 429 ? 'rate_limit'
            : response.status >= 500 ? 'server' : 'http';
      throw new MailTmError(operation, detail, response.status, { kind, diagnostics: lastHttpDiagnostics });
    }
    throw new MailTmError(operation, 'request exhausted retries', null, { kind: 'retry_exhausted', diagnostics: lastHttpDiagnostics });
  }

  async inspectDomains() {
    const pages = [];
    const entries = [];
    let page = 1;
    let expectedTotal = null;
    let hasNext = true;
    let firstSchemaKeys = [];

    while (hasNext) {
      if (page > this.maxPages) {
        throw new MailTmError('domain discovery', 'pagination exceeded the configured page limit', null, {
          kind: 'pagination_limit',
          diagnostics: { pagesFetched: pages.length, paginationComplete: false, requestDurationMs: pages.reduce((sum, item) => sum + item.durationMs, 0) },
        });
      }
      const result = await this.request('domain discovery', `/domains?page=${page}`, { metadata: true });
      if (page === 1) firstSchemaKeys = schemaKeys(result.data);
      let collection;
      try {
        collection = assertCollection(result.data, 'domain discovery');
      } catch (error) {
        if (error instanceof MailTmError) {
          error.diagnostics = {
            ...(error.diagnostics ?? {}),
            httpStatus: result.httpStatus,
            contentType: result.contentType,
            responseSchema: firstSchemaKeys,
            requestDurationMs: result.durationMs,
            pagesFetched: pages.length + 1,
          };
        }
        throw error;
      }
      if (expectedTotal === null) expectedTotal = collection.totalItems;
      pages.push({ httpStatus: result.httpStatus, contentType: result.contentType, durationMs: result.durationMs, itemCount: collection.members.length });
      entries.push(...collection.members);

      const expectedPages = Math.max(1, Math.ceil(expectedTotal / PAGE_SIZE));
      if (collection.totalItems !== expectedTotal) {
        throw new MailTmError('domain discovery', 'hydra:totalItems changed while pages were being read', null, {
          kind: 'pagination_inconsistent',
          diagnostics: { totalDomainCount: expectedTotal, pageReportedTotal: collection.totalItems, pagesFetched: pages.length, paginationComplete: false },
        });
      }
      hasNext = page < expectedPages || collection.hasNext;
      if (hasNext && collection.members.length === 0) {
        throw new MailTmError('domain discovery', 'pagination ended before hydra:totalItems was reached', null, {
          kind: 'pagination_incomplete',
          diagnostics: { totalDomainCount: expectedTotal, returnedDomainCount: entries.length, pagesFetched: pages.length, paginationComplete: false, requestDurationMs: pages.reduce((sum, item) => sum + item.durationMs, 0) },
        });
      }
      page += 1;
    }

    if (entries.length !== expectedTotal) {
      throw new MailTmError('domain discovery', 'the paginated response count did not match hydra:totalItems', null, {
        kind: 'pagination_incomplete',
        diagnostics: { totalDomainCount: expectedTotal, returnedDomainCount: entries.length, pagesFetched: pages.length, paginationComplete: false, requestDurationMs: pages.reduce((sum, item) => sum + item.durationMs, 0) },
      });
    }

    let activePublicDomainCount = 0;
    let activePrivateDomainCount = 0;
    let inactiveDomainCount = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.domain !== 'string' || entry.domain.trim().length === 0
        || typeof entry.isActive !== 'boolean' || typeof entry.isPrivate !== 'boolean') {
        throw new MailTmError('domain discovery', 'unexpected domain entry schema: domain, isActive, and isPrivate are required', null, {
          kind: 'schema',
          diagnostics: {
            responseSchema: firstSchemaKeys,
            totalDomainCount: expectedTotal,
            returnedDomainCount: entries.length,
            pagesFetched: pages.length,
            paginationComplete: true,
            httpStatus: pages[0]?.httpStatus ?? null,
            contentType: pages[0]?.contentType ?? 'unknown',
            requestDurationMs: pages.reduce((sum, item) => sum + item.durationMs, 0),
          },
        });
      }
      if (entry.isActive && !entry.isPrivate) activePublicDomainCount += 1;
      else if (entry.isActive && entry.isPrivate) activePrivateDomainCount += 1;
      else inactiveDomainCount += 1;
    }

    const domains = [...new Set(entries
      .filter((entry) => entry.isActive === true && entry.isPrivate === false)
      .map((entry) => entry.domain.trim().toLowerCase()))];
    const diagnostics = {
      httpStatus: pages[0]?.httpStatus ?? null,
      contentType: pages[0]?.contentType ?? 'unknown',
      responseSchema: { topLevelKeys: firstSchemaKeys, collectionKey: 'hydra:member' },
      totalDomainCount: expectedTotal,
      returnedDomainCount: entries.length,
      activePublicDomainCount,
      activePrivateDomainCount,
      inactiveDomainCount,
      pagination: { pagesFetched: pages.length, paginationComplete: true, pageStatuses: pages.map((item) => item.httpStatus) },
      requestDurationMs: pages.reduce((sum, item) => sum + item.durationMs, 0),
      pageDiagnostics: pages.map(({ httpStatus, contentType, durationMs, itemCount }) => ({ httpStatus, contentType, durationMs, itemCount })),
      reason: expectedTotal === 0 ? 'no_domains_returned' : domains.length === 0 ? 'domains_exist_but_none_are_active_public' : 'usable_domains_found',
    };
    return { domains, diagnostics };
  }

  async discoverDomains() {
    return (await this.inspectDomains()).domains;
  }

  async createMailbox({ username, password, domain } = {}) {
    if (!/^[a-z0-9]{3,30}$/.test(username ?? '')) throw new TypeError('Mailbox username has an invalid format.');
    if (typeof password !== 'string' || password.length < 20) throw new TypeError('Mailbox password must be at least 20 characters.');
    const domains = await this.discoverDomains();
    if (domains.length === 0) throw new MailTmError('mailbox creation', 'no active public domains are available', null, { kind: 'no_usable_domains' });
    if (domain !== undefined && !domains.includes(domain.toLowerCase())) throw new MailTmError('mailbox creation', 'the requested domain was not in the verified active public domain list', null, { kind: 'no_usable_domains' });
    const address = `${username}@${domain?.toLowerCase() ?? domains[0]}`;
    const account = await this.createAccount({ address, password });
    const token = await this.authenticateMailbox({ address, password });
    return { accountId: account.id, address, password, token };
  }

  async createAccount({ address, password }) {
    if (typeof address !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(address)) throw new TypeError('A valid Mail.tm address is required.');
    if (typeof password !== 'string' || password.length < 20) throw new TypeError('Mailbox password must be at least 20 characters.');
    let account;
    try {
      // Account creation is non-idempotent: do not repeat POST /accounts if its result is ambiguous.
      account = await this.request('mailbox creation', '/accounts', { method: 'POST', body: { address, password }, retries: 0 });
    } catch (error) {
      if (error instanceof MailTmError) {
        error.accountCreationOutcome = error.status && error.status < 500 ? 'not_created' : 'unknown';
      }
      throw error;
    }
    if (typeof account?.id !== 'string' || account.id.length === 0) {
      const error = new MailTmError('mailbox creation', 'the API response did not include an account id', null, { kind: 'schema' });
      error.accountCreationOutcome = 'unknown';
      throw error;
    }
    return account;
  }

  async authenticateMailbox({ address, password }) {
    if (typeof address !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(address)) throw new TypeError('A valid Mail.tm address is required.');
    if (typeof password !== 'string' || password.length < 20) throw new TypeError('Mailbox password must be at least 20 characters.');
    const auth = await this.request('authentication', '/token', { method: 'POST', body: { address, password } });
    if (typeof auth?.token !== 'string' || auth.token.length < 10) {
      throw new MailTmError('authentication', 'the API response did not include a usable token', null, { kind: 'schema' });
    }
    return auth.token;
  }

  async getMe(token, { signal } = {}) {
    if (typeof token !== 'string' || token.length === 0) throw new TypeError('A Mail.tm authentication token is required.');
    return this.request('account verification', '/me', { token, signal });
  }

  async deleteMailbox(token, accountId, { signal } = {}) {
    if (typeof token !== 'string' || token.length === 0) throw new TypeError('A Mail.tm authentication token is required.');
    if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 200) throw new TypeError('A valid Mail.tm account identifier is required.');
    return this.request('mailbox cleanup', `/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE', token, signal });
  }

  async getInbox(token, { signal, timeoutMs, deadline } = {}) {
    if (typeof token !== 'string' || token.length === 0) throw new TypeError('A Mail.tm authentication token is required.');
    const messages = [];
    let page = 1;
    let expectedTotal = null;
    let hasNext = true;
    while (hasNext) {
      if (page > this.maxPages) throw new MailTmError('inbox retrieval', 'pagination exceeded the configured page limit', null, { kind: 'pagination_limit' });
      const data = await this.request('inbox retrieval', `/messages?page=${page}`, { token, signal, timeoutMs, deadline });
      const collection = assertCollection(data, 'inbox retrieval');
      if (expectedTotal === null) expectedTotal = collection.totalItems;
      if (collection.totalItems !== expectedTotal) throw new MailTmError('inbox retrieval', 'hydra:totalItems changed while pages were being read', null, { kind: 'pagination_inconsistent' });
      messages.push(...collection.members);
      hasNext = page < Math.max(1, Math.ceil(expectedTotal / PAGE_SIZE)) || collection.hasNext;
      if (hasNext && collection.members.length === 0) throw new MailTmError('inbox retrieval', 'pagination ended before hydra:totalItems was reached', null, { kind: 'pagination_incomplete' });
      page += 1;
    }
    if (messages.length !== expectedTotal) throw new MailTmError('inbox retrieval', 'the paginated response count did not match hydra:totalItems', null, { kind: 'pagination_incomplete' });
    for (const message of messages) {
      if (!message || typeof message !== 'object' || typeof message.id !== 'string') {
        throw new MailTmError('inbox retrieval', 'unexpected message entry schema: each message must include an id', null, { kind: 'schema' });
      }
    }
    return messages;
  }

  async pollInbox(token, {
    maxAttempts = 12,
    intervalMs = 5000,
    timeoutMs = Math.max(this.timeoutMs, maxAttempts * intervalMs),
    signal,
    shouldStop = (messages) => messages.length > 0,
  } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new RangeError('Inbox polling attempts must be between 1 and 100.');
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new RangeError('Inbox polling interval cannot be negative.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('Inbox polling timeout must be a positive number of milliseconds.');
    if (typeof shouldStop !== 'function') throw new TypeError('Inbox polling shouldStop must be a function.');
    const startedAt = this.now();
    const deadline = startedAt + timeoutMs;
    const results = [];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new MailTmError('inbox polling', 'polling was cancelled', null, { kind: 'cancelled' });
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) return { messages: results, attempts: attempt, timedOut: true };
      let messages;
      try {
        messages = await this.getInbox(token, { signal, timeoutMs: this.timeoutMs, deadline });
      } catch (error) {
        if (error instanceof MailTmError && error.kind === 'timeout' && this.now() >= deadline) {
          return { messages: results, attempts: attempt + 1, timedOut: true };
        }
        throw error;
      }
      results.push(...messages);
      if (shouldStop(messages)) return { messages: results, attempts: attempt + 1, timedOut: false };
      if (attempt + 1 < maxAttempts) {
        const waitMs = Math.min(intervalMs, Math.max(0, deadline - this.now()));
        if (waitMs > 0) {
          await this.sleepOrCancel(waitMs, signal, 'inbox polling');
        }
      }
    }
    return { messages: results, attempts: maxAttempts, timedOut: true };
  }

  async getMessage(token, id, { signal } = {}) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 200) throw new TypeError('A valid Mail.tm message identifier is required.');
    if (typeof token !== 'string' || token.length === 0) throw new TypeError('A Mail.tm authentication token is required.');
    const message = await this.request('message retrieval', `/messages/${encodeURIComponent(id)}`, { token, signal });
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') {
      throw new MailTmError('message retrieval', 'unexpected message schema', null, { kind: 'schema' });
    }
    return message;
  }
}
