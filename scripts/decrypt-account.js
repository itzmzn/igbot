import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readEncryptedCredentials } from '../src/storage/account.js';

const [sourcePath, requestedOutput] = process.argv.slice(2);
if (!sourcePath) {
  process.stderr.write('Usage: ACCOUNT_ENCRYPTION_KEY=<base64-key> node scripts/decrypt-account.js <account.enc> [private-output.json]\n');
  process.exit(2);
}
if (!process.env.ACCOUNT_ENCRYPTION_KEY) {
  process.stderr.write('ACCOUNT_ENCRYPTION_KEY is required in the environment.\n');
  process.exit(2);
}
const outputPath = path.resolve(requestedOutput ?? sourcePath.replace(/\.enc$/, '.private.json'));
try {
  const credentials = await readEncryptedCredentials(path.resolve(sourcePath), process.env.ACCOUNT_ENCRYPTION_KEY);
  const handle = await open(outputPath, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, 'utf8'); } finally { await handle.close(); }
  process.stdout.write(`Decrypted credentials were written to ${outputPath}; keep this local file private.\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
