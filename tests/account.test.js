import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createAccountMetadata,
  decryptCredentials,
  encryptCredentials,
  saveAccount,
  validateAccountMetadata,
} from '../src/storage/account.js';

const key = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const credentials = { username: 'igmockuser', password: 'Mock-only-Not-A-Real-Password-1!', mailboxPassword: 'Mock-mailbox-only-Password-123!' };

test('AES-256-GCM credential encryption decrypts and detects tampering', () => {
  const encrypted = encryptCredentials(credentials, key);
  assert.equal(encrypted.includes(credentials.password), false);
  assert.deepEqual(decryptCredentials(encrypted, key), credentials);
  const envelope = JSON.parse(encrypted);
  envelope.ciphertext = Buffer.from('changed').toString('base64');
  assert.throws(() => decryptCredentials(JSON.stringify(envelope), key), /decryption failed/i);
});

test('account metadata has the expected safe schema and validates as JSON', () => {
  const metadata = createAccountMetadata({
    username: 'igmockuser',
    email: 'igmockuser@mail.example',
    status: 'confirmed',
    createdAt: '2026-10-11T10:00:00.000Z',
  });
  assert.deepEqual(metadata, {
    platform: 'instagram',
    username: 'igmockuser',
    email: 'igmockuser@mail.example',
    status: 'confirmed',
    createdAt: '2026-10-11T10:00:00.000Z',
    verificationMethod: 'email',
    credentialsFile: 'igmockuser.enc',
  });
  assert.equal(validateAccountMetadata(JSON.parse(JSON.stringify(metadata))), true);
  assert.equal(validateAccountMetadata({ ...metadata, credentialsFile: 'wrong.enc' }), false);
  assert.equal(validateAccountMetadata({ ...metadata, username: '..' }), false);
  assert.throws(() => createAccountMetadata({ username: '..', email: 'a@example.test', status: 'confirmed' }), /username/i);
});

test('saveAccount writes metadata and encrypted credentials only, with no plaintext secret', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'igbot-account-'));
  try {
    const saved = await saveAccount({
      username: 'igmockuser',
      email: 'igmockuser@mail.example',
      status: 'confirmed',
      credentials,
      encryptionKey: key,
      directory,
      createdAt: '2026-10-11T10:00:00.000Z',
    });
    const metadataText = await readFile(saved.metadataPath, 'utf8');
    const encryptedText = await readFile(saved.credentialPath, 'utf8');
    assert.equal(validateAccountMetadata(JSON.parse(metadataText)), true);
    assert.equal(metadataText.includes(credentials.password), false);
    assert.equal(encryptedText.includes(credentials.password), false);
    assert.deepEqual(decryptCredentials(encryptedText, key), credentials);
    if (process.env.DEBUG_ARTIFACTS === '1') {
      const debugDirectory = path.resolve('artifacts/debug');
      await mkdir(debugDirectory, { recursive: true });
      await copyFile(saved.metadataPath, path.join(debugDirectory, 'mock-account.json'));
    }
    await assert.rejects(saveAccount({
      username: 'igmockuser', email: 'igmockuser@mail.example', status: 'confirmed', credentials, encryptionKey: key, directory,
    }), /already exists/i);
    assert.equal(JSON.parse(await readFile(saved.metadataPath, 'utf8')).status, 'confirmed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
