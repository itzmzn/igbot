import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateAccountMetadata } from '../src/storage/account.js';

const [fileArg, confirmation] = process.argv.slice(2);
if (!fileArg || confirmation !== '--instagram-confirmed') {
  process.stderr.write('Usage: node scripts/mark-confirmed.js accounts/<username>.json --instagram-confirmed\n');
  process.stderr.write('Use this only after manually confirming the account is active on Instagram.\n');
  process.exit(2);
}
const filePath = path.resolve(fileArg);
const tempPath = `${filePath}.${randomUUID()}.tmp`;
try {
  const metadata = JSON.parse(await readFile(filePath, 'utf8'));
  if (!validateAccountMetadata(metadata)) throw new Error('Account metadata failed schema validation.');
  if (metadata.status === 'confirmed') throw new Error('Account is already marked confirmed.');
  metadata.status = 'confirmed';
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(tempPath, filePath);
  process.stdout.write('Metadata updated after the supplied manual confirmation.\n');
} catch (error) {
  await unlink(tempPath).catch(() => {});
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
