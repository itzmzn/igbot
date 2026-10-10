import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateAccountMetadata } from '../src/storage/account.js';

const filePath = process.argv[2];
if (!filePath) {
  process.stderr.write('Usage: node scripts/validate-account-json.js accounts/<username>.json\n');
  process.exit(2);
}
try {
  const metadata = JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
  if (!validateAccountMetadata(metadata)) throw new Error('Account metadata failed schema validation.');
  process.stdout.write('Account metadata JSON is valid.\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
