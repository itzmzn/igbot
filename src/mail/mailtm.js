const DEFAULT_BASE_URL = 'https://api.mail.tm';
const DEFAULT_RETRIES = 3;

export class MailTmError extends Error {
  constructor(operation, message, status = null) {
    super(`Mail.tm ${operation} failed${status ? ` (HTTP ${status})` : ''}: ${message}`);
    this.name = 'MailTmError';
    this.operation = operation;
    this.status = status;
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MailTmClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, retries = DEFAULT_RETRIES, retryDelayMs = 200, sleep = pause } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new RangeError('Mail.tm retries must be between 0 and 5.');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.sleep = sleep;
  }

  async request(operation, path, { method = 'GET', token, body } = {}) {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers: {
            accept: 'application/json',
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        if (attempt < this.retries) {
          await this.sleep(this.retryDelayMs * (2 ** attempt));
          continue;
        }
        throw new MailTmError(operation, 'network request failed after bounded retries');
      }

      if (response.ok) {
        try {
          return response.status === 204 ? null : await response.json();
        } catch {
          throw new MailTmError(operation, 'the API returned invalid JSON', response.status);
        }
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.retries) {
        await this.sleep(this.retryDelayMs * (2 ** attempt));
        continue;
      }
      throw new MailTmError(operation, retryable ? 'the API remained unavailable after bounded retries' : 'the API rejected the request', response.status);
    }
    throw new MailTmError(operation, 'request exhausted retries');
  }

  async discoverDomains() {
    const firstPage = await this.request('domain discovery', '/domains?page=1');
    const firstMembers = Array.isArray(firstPage?.['hydra:member']) ? firstPage['hydra:member'] : [];
    const totalItems = Number(firstPage?.['hydra:totalItems']);
    const pages = Number.isFinite(totalItems) && totalItems > 0
      ? Math.max(1, Math.min(5, Math.ceil(totalItems / 30)))
      : 1;
    const entries = [...firstMembers];
    for (let page = 2; page <= pages; page += 1) {
      const data = await this.request('domain discovery', `/domains?page=${page}`);
      const members = Array.isArray(data?.['hydra:member']) ? data['hydra:member'] : [];
      entries.push(...members);
      if (members.length === 0) break;
    }

    let domains = entries
      .filter((entry) => entry && typeof entry.domain === 'string' && entry.isActive !== false && entry.isPrivate !== true)
      .map((entry) => entry.domain.toLowerCase());

    // Some Mail.tm-compatible responses ignore the optional page query; retry the documented bare collection once if empty.
    if (domains.length === 0) {
      const fallback = await this.request('domain discovery', '/domains');
      const members = Array.isArray(fallback?.['hydra:member']) ? fallback['hydra:member'] : [];
      domains = members
        .filter((entry) => entry && typeof entry.domain === 'string' && entry.isActive !== false && entry.isPrivate !== true)
        .map((entry) => entry.domain.toLowerCase());
    }
    return [...new Set(domains)];
  }

  async createMailbox({ username, password }) {
    if (!/^[a-z0-9]{3,30}$/.test(username)) throw new TypeError('Mailbox username has an invalid format.');
    if (typeof password !== 'string' || password.length < 20) throw new TypeError('Mailbox password must be at least 20 characters.');
    const domains = await this.discoverDomains();
    if (domains.length === 0) throw new MailTmError('domain discovery', 'no active public domains were returned');
    const address = `${username}@${domains[0]}`;
    await this.request('mailbox creation', '/accounts', { method: 'POST', body: { address, password } });
    const auth = await this.request('authentication', '/token', { method: 'POST', body: { address, password } });
    if (typeof auth?.token !== 'string' || auth.token.length < 10) {
      throw new MailTmError('authentication', 'the API response did not include a usable token');
    }
    return { address, password, token: auth.token };
  }

  async getInbox(token) {
    if (typeof token !== 'string' || token.length === 0) throw new TypeError('A Mail.tm authentication token is required.');
    const data = await this.request('inbox retrieval', '/messages?page=1', { token });
    return Array.isArray(data?.['hydra:member']) ? data['hydra:member'] : [];
  }

  async pollInbox(token, { maxAttempts = 12, intervalMs = 5000, shouldStop = (messages) => messages.length > 0 } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 30) throw new RangeError('Inbox polling attempts must be between 1 and 30.');
    const results = [];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const messages = await this.getInbox(token);
      results.push(...messages);
      if (shouldStop(messages)) return { messages: results, attempts: attempt + 1, timedOut: false };
      if (attempt + 1 < maxAttempts) await this.sleep(intervalMs);
    }
    return { messages: results, attempts: maxAttempts, timedOut: true };
  }

  async getMessage(token, id) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 200) throw new TypeError('A valid Mail.tm message identifier is required.');
    return this.request('message retrieval', `/messages/${encodeURIComponent(id)}`, { token });
  }
}
