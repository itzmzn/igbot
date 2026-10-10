# igbot

A single-account Instagram registration assistant built with Node.js 22, Playwright, Chromium, [Mail.tm](https://mail.tm), Node.js crypto, and GitHub Actions.

The automated signup flow is disabled unless one manually dispatched workflow run includes an explicit authorization phrase and the repository has the registrant's truthful full name, truthful date of birth, and an encryption key configured as GitHub Actions secrets. Automated tests use only a local mock signup page. The project does not solve CAPTCHAs, evade rate limits, retry a real signup submission, or enter verification codes.

## What it does

- Generates one cryptographically random username and a 24-character password per authorized run.
- Discovers a public Mail.tm domain, creates a temporary mailbox, authenticates, and polls its inbox with bounded retries.
- Uses Playwright locators with visible-element checks and selector diagnostics before entering signup details.
- Supports a date input and accessible month/day/year dropdowns for date of birth.
- Stops on CAPTCHA, rate limiting, phone checks, suspicious-activity warnings, email verification, or an unknown page state.
- Retrieves a verification email when one is available, but does not parse or redeem its code. The message is stored only inside the encrypted credential file for manual review.
- Stores metadata in `accounts/{username}.json` and AES-256-GCM encrypted credentials in `accounts/{username}.enc` after the signup form is submitted and the result is classified.

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

Debug screenshots and traces contain only synthetic mock form values. They do not contain a real browser session. A failed test's assertion and stack are available in the Actions run log; the uploaded JSON summaries contain sanitized categories and selector presence/counts only.

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

The workflow is non-interactive. If Instagram requires email, phone, CAPTCHA, or another human check, it stops and reports that status. It does not bypass the check. Download the run's `igbot-account-*` artifact. It contains non-sensitive JSON metadata and an encrypted `.enc` credential file; keep the artifact private because people with repository read access may be able to download it. Do not publish decrypted credentials.

Decrypt the artifact locally only when needed, using the key file you retained above:

```bash
ACCOUNT_ENCRYPTION_KEY="$(< "$HOME/.config/igbot/account-key")" \
  node scripts/decrypt-account.js accounts/USERNAME.enc accounts/USERNAME.private.json
```

The command writes a mode-0600 private file and never prints credential contents. Use the Mail.tm credentials and any verification message there to complete the check manually on Instagram. Once you have personally confirmed the account is active, update the local metadata with:

```bash
node scripts/mark-confirmed.js accounts/USERNAME.json --instagram-confirmed
```

This command is an operator attestation, not an Instagram check. Keep account files and decrypted files out of Git. The `.gitignore` excludes them.

## Manual workflow from GitHub

Open **Actions → Assisted Instagram registration → Run workflow**. Set `authorize_once` to true and enter the exact phrase `AUTHORIZE ONE REAL REGISTRATION`. The name and DOB are read from Actions secrets; they are not workflow inputs.

## Privacy and limits

- GitHub Actions artifacts in this public repository may be downloadable by repository readers. Account credentials are AES-256-GCM encrypted before upload; the key is not stored in Git or the artifact. Metadata has no password, date of birth, Mail.tm password, token, OTP, or cookie.
- The encrypted credential artifact is retained for two days by default. Download it promptly after a run that needs manual verification.
- The encrypted credential bundle can contain the Mail.tm password and, if present, the retrieved verification email. It never contains browser cookies or storage state.
- The debug workflow operates only on local mock pages and uploads synthetic screenshots and traces.
- Mail.tm availability, domain policy, API limits, and Instagram signup behavior are external dependencies and can change. A Mail.tm outage or Instagram security challenge ends the attempt; there are no repeated real signup submissions.
- A successful mock test is not evidence that an Instagram account was created.

## License

MIT. See [LICENSE](LICENSE).
