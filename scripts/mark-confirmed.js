import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAccountMetadata, readEncryptedCredentials, validateAccountMetadata } from '../src/storage/account.js';

const [fileArg, confirmation] = process.argv.slice(2);
if (!fileArg || confirmation !== '--instagram-confirmed') {
  process.stderr.write('Usage: ACCOUNT_ENCRYPTION_KEY=<key> node scripts/mark-confirmed.js accounts/<username>.enc|.json --instagram-confirmed\n');
  process.stderr.write('Use this only after manually confirming the account is active on Instagram.\n');
  process.exit(2);
}
const filePath = path.resolve(fileArg);
const isEncryptedCredentialFile = filePath.endsWith('.enc');
const metadataPath = isEncryptedCredentialFile ? filePath.replace(/\.enc$/, '.json') : filePath;
const tempPath = `${metadataPath}.${randomUUID()}.tmp`;
let createdMetadata = false;
try {
  if (isEncryptedCredentialFile) {
    if (!process.env.ACCOUNT_ENCRYPTION_KEY) throw new Error('ACCOUNT_ENCRYPTION_KEY is required to read the encrypted credentials.');
    const credentials = await readEncryptedCredentials(filePath, process.env.ACCOUNT_ENCRYPTION_KEY);
    if (path.basename(filePath, '.enc') !== credentials.username) throw new Error('The encrypted filename does not match its account username.');
    const metadata = createAccountMetadata({
      username: credentials.username,
      email: credentials.email,
      status: 'confirmed',
      createdAt: credentials.submittedAt,
    });
    const handle = await open(metadataPath, 'wx', 0o600);
    createdMetadata = true;
    try { await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'); } finally { await handle.close(); }
  } else {
    const metadata = JSON.parse(await readFile(filePath, 'utf8'));
    if (!validateAccountMetadata(metadata)) throw new Error('Account metadata failed schema validation.');
    if (metadata.status === 'confirmed') throw new Error('Account is already marked confirmed.');
    metadata.status = 'confirmed';
    await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(tempPath, filePath);
  }
  process.stdout.write('Account metadata was created or updated after the supplied manual confirmation.\n');
} catch (error) {
  await unlink(tempPath).catch(() => {});
  if (createdMetadata) await unlink(metadataPath).catch(() => {});
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
