# igbot

A single-account Instagram registration assistant built with Node.js 22, Playwright, Chromium, [Mail.tm](https://mail.tm), Node.js crypto, and GitHub Actions.

The automated signup flow is disabled unless one manually dispatched workflow run includes an explicit authorization phrase and the repository has the registrant's truthful full name, truthful date of birth, and an encryption key configured as GitHub Actions secrets. Automated tests use only a local mock signup page. The project does not solve CAPTCHAs, evade rate limits, retry a real signup submission, or enter verification codes.

## What it does

- Generates one cryptographically random username and a 24-character password per authorized run.
- Discovers only explicitly active, non-private Mail.tm domains; creates a temporary mailbox, authenticates, and polls all inbox pages with bounded retries.
- Uses Playwright locators with visible-element checks and selector diagnostics before entering signup details.
- Supports a date input and accessible month/day/year dropdowns for date of birth.
- Stops on CAPTCHA, rate limiting, phone checks, suspicious-activity warnings, email verification, or an unknown page state.
- Detects incoming verification mail without reading its contents or extracting a code; verification must be completed manually.
- Writes JSON metadata only after Instagram displays a recognized success confirmation. If submission occurs but the result is pending or unclear, it preserves only AES-256-GCM encrypted credentials.

Instagram can change its page or selectors at any time. An unknown or changed form stops before submission when the page cannot be identified safely. Instagram may also reject automated browser signup or Mail.tm; this project reports those outcomes and does not work around them.

## Repository secrets

Before a real workflow run, configure these repository secrets:

- `REGISTRANT_FULL_NAME`: the actual registrant's full name.
- `REGISTRANT_DOB`: their truthful date of birth in `YYYY-MM-DD` format.
- `ACCOUNT_ENCRYPTION_KEY`: base64 encoding of exactly 32 random bytes.

Generate and retain the key in a private local file, then store the same key as a repository secret. Do not commit it. In Termux, for example:

```bash
mkdir -p "$HOME/.config/igbot"
umask 077
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' > "$HOME/.config/igbot/account-key"
gh secret set ACCOUNT_ENCRYPTION_KEY --repo itzmzn/igbot < "$HOME/.config/igbot/account-key"
gh secret set REGISTRANT_FULL_NAME --repo itzmzn/igbot
gh secret set REGISTRANT_DOB --repo itzmzn/igbot
```

The last two commands read their secret values from standard input; enter the truthful value without putting it in shell history. Keep the key file private and back it up securely. GitHub does not reveal a saved secret later, so losing the local key makes encrypted credentials unrecoverable.

## Tests

All Chromium installation and browser execution are performed by GitHub-hosted Ubuntu runners. No local Chromium or Playwright browser installation is needed.

From Termux, trigger the mock-only CI workflow and wait for its result:

```bash
gh workflow run test.yml --repo itzmzn/igbot --ref main
gh run list --repo itzmzn/igbot --workflow test.yml --limit 5
gh run watch --repo itzmzn/igbot
```

For additional screenshots, traces, selector diagnostics, browser console error summaries, and network failure summaries, run:

```bash
gh workflow run debug.yml --repo itzmzn/igbot --ref main
gh run list --repo itzmzn/igbot --workflow debug.yml --limit 5
gh run watch --repo itzmzn/igbot
```

Debug screenshots and traces contain only synthetic mock form values. They do not contain a real browser session. A failed test's assertion and stack are available in the Actions run log; uploaded JSON summaries contain selector counts, coarse form state, and sanitized visible validation messages.

## Mail.tm integration and diagnostics

Mail.tm does not require an API key. The client uses the official `https://api.mail.tm` API, reads the documented Hydra collection (`hydra:member`, `hydra:totalItems`, and `hydra:view`), and follows its 30-item pagination. A domain is eligible only when `isActive` is `true` and `isPrivate` is `false`; the project does not guess or hardcode domains, fall back to a different response shape, or convert a malformed response into an empty list. The diagnostic distinguishes an empty list from domains that exist but are inactive/private.

The client creates a mailbox with `POST /accounts`, obtains its bearer token with `POST /token`, validates it through `GET /me`, and reads `GET /messages` and individual `GET /messages/{id}` resources. Inbox polling has configurable intervals, an overall timeout, cancellation support, and paginated retrieval. Message timestamps and sender metadata remain available to callers. The assistant never extracts or submits an Instagram verification code.

Requests use a timeout and stay at or below the documented eight requests per second per client/IP. Safe reads and token requests use bounded exponential backoff; HTTP 429 honors `Retry-After` and waits at least one second, while 401/403 authentication failures and 422 payload validation failures are reported without retry. `POST /accounts` is sent once because a network/server failure can occur after the API creates the account, and repeating it could create duplicates; an ambiguous response is reported as an unknown creation outcome. Timeouts, DNS, TLS, HTTP, malformed JSON, unexpected schemas, and pagination failures have separate error categories. Error messages and the diagnostic output omit request bodies, passwords, bearer tokens, and mailbox addresses.

From Termux, run the read-only live diagnostic on GitHub-hosted Ubuntu. It reports HTTP status, content type, response schema keys, domain counts, pagination, request duration, and a sanitized failure reason. It creates no mailbox:

```bash
gh workflow run mailtm.yml --repo itzmzn/igbot --ref main \
  -f mode=diagnostic -f authorize_mailbox_test=false
gh run list --repo itzmzn/igbot --workflow mailtm.yml --limit 5
gh run watch --repo itzmzn/igbot
```

The separately authorized Mail.tm integration mode creates at most one random test mailbox, checks account creation, token authentication, `/me`, and the initially empty inbox, then attempts to delete that test mailbox in a `finally` cleanup. Run it only after a diagnostic finds an active public domain, and only when you accept the permanent-deletion risk:

```bash
gh workflow run mailtm.yml --repo itzmzn/igbot --ref main \
  -f mode=mailbox-test \
  -f authorize_mailbox_test=true \
  -f confirmation='AUTHORIZE ONE MAILTM TEST MAILBOX'
gh run list --repo itzmzn/igbot --workflow mailtm.yml --limit 5
gh run watch --repo itzmzn/igbot
```

The live mailbox test does not send synthetic email and does not contact Instagram. Synthetic message reception, pagination, sender/timestamp handling, and message retrieval are covered by mocked tests. If a live mailbox test is interrupted or cleanup fails, the test mailbox may remain accessible until Mail.tm removes it; the workflow does not print its address or password, so retain no expectation that it can be recovered from logs. A Mail.tm account deleted through its API cannot be restored. Mail.tm documents an eight-query-per-second limit and asks API users to link to Mail.tm; this README provides that attribution. See the [Mail.tm API documentation](https://docs.mail.tm/), [domain reference](https://docs.mail.tm/api/domains), [account reference](https://docs.mail.tm/api/accounts), [authentication guide](https://docs.mail.tm/getting-started/authentication), [messages reference](https://docs.mail.tm/api/messages), and [error handling guide](https://docs.mail.tm/getting-started/error-handling).

## One real assisted registration

A real registration is a separate action. The test workflow never visits Instagram. After checking the repository secrets and confirming that one account is authorized, manually dispatch `signup.yml` and set both required authorization inputs. The workflow rejects reruns of the same run (`GITHUB_RUN_ATTEMPT` must be `1`) and performs at most one submit click per run.

From Termux:

```bash
gh workflow run signup.yml --repo itzmzn/igbot --ref main \
  -f authorize_once=true \
  -f confirmation_phrase='AUTHORIZE ONE REAL REGISTRATION'
gh run list --repo itzmzn/igbot --workflow signup.yml --limit 5
gh run watch --repo itzmzn/igbot
```

Do not dispatch this workflow for a mock test. A run without both authorization inputs and all three secrets fails before dependency installation, mailbox creation, or Instagram navigation. Never use a generated or guessed identity for a real registration.

The workflow is non-interactive. If Instagram requires email, phone, CAPTCHA, or another human check, it stops and reports that status. It does not bypass the check. A success state requires both Instagram's signup confirmation and a fresh-context login that exposes the account's profile and inbox controls. It never saves browser cookies or storage state. Unknown outcomes produce a separate sanitized JSON diagnostic artifact with state codes, a safe current URL, coarse route changes, control counts, field categories and validity flags, visible alert/status/inline validation text, network failure hosts, and dialog types. The text scrubber removes configured identity and credential values plus email addresses, phone numbers, OTP-sized numbers, bearer/JWT tokens, and common secret-bearing URL parameters. Real-run screenshots and traces are not uploaded.

Download the run's `igbot-account-*` artifact promptly and store it in a private location. When both signup and login are confirmed, it contains JSON metadata and an encrypted `.enc` credential file. For a pending or unknown outcome, it contains only the encrypted `.enc` file. Account artifacts are retained for up to 90 days; keep your own private copy for long-term access. People with repository read access may be able to download artifacts, so never upload a decryption key or decrypted credential file.

Decrypt the artifact locally only when needed, using the key file you retained above:

```bash
ACCOUNT_ENCRYPTION_KEY="$(< "$HOME/.config/igbot/account-key")" \
  node scripts/decrypt-account.js accounts/USERNAME.enc accounts/USERNAME.private.json
```

The command writes a mode-0600 private file and never prints credential contents. Use the Mail.tm credentials to sign in to the inbox manually and complete any verification in a trusted browser. The workflow does not retrieve, store, or submit verification codes. If registration was not confirmed, no JSON metadata file exists. After you personally confirm the account is active, create metadata from the encrypted credentials with:

```bash
ACCOUNT_ENCRYPTION_KEY="$(< "$HOME/.config/igbot/account-key")" \
  node scripts/mark-confirmed.js accounts/USERNAME.enc --instagram-confirmed
```

This command is an operator attestation, not an Instagram check. Keep account files and decrypted files out of Git. The `.gitignore` excludes them.

## Manual workflow from GitHub

Open **Actions → Assisted Instagram registration → Run workflow**. Set `authorize_once` to true and enter the exact phrase `AUTHORIZE ONE REAL REGISTRATION`. The name and DOB are read from Actions secrets; they are not workflow inputs.

## Privacy and limits

- GitHub Actions artifacts in this public repository may be downloadable by repository readers. Account credentials are AES-256-GCM encrypted before upload; the key is not stored in Git or the artifact. Metadata has no password, date of birth, Mail.tm password, token, OTP, or cookie.
- The encrypted credential artifact is retained for up to 90 days. Download it promptly after a run that needs manual verification and keep a private local recovery copy.
- The encrypted credential bundle can contain the Instagram password and Mail.tm login credentials. It never contains message contents, browser cookies, or storage state.
- The debug workflow operates only on local mock pages and uploads synthetic screenshots and traces.
- Mail.tm availability, domain policy, API limits, and Instagram signup behavior are external dependencies and can change. A Mail.tm outage or Instagram security challenge ends the attempt; there are no repeated real signup submissions.
- A successful mock test is not evidence that an Instagram account was created.

## License

MIT. See [LICENSE](LICENSE).
