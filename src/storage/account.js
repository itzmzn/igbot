import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const ALLOWED_STATUSES = new Set([
  'confirmed',
  'awaiting_manual_verification',
  'security_challenge',
  'registration_unconfirmed',
]);

export function decodeEncryptionKey(encodedKey) {
  if (typeof encodedKey !== 'string' || encodedKey.length === 0) throw new Error('ACCOUNT_ENCRYPTION_KEY is required.');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encodedKey.replace(/=+$/, '')) {
    throw new Error('ACCOUNT_ENCRYPTION_KEY must be a base64 encoded 32-byte key.');
  }
  return key;
}

export function encryptCredentials(credentials, encodedKey) {
  const key = decodeEncryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }, null, 2) + '\n';
}

export function decryptCredentials(encryptedText, encodedKey) {
  const key = decodeEncryptionKey(encodedKey);
  let envelope;
  try { envelope = JSON.parse(encryptedText); } catch { throw new Error('Encrypted credential file is not valid JSON.'); }
  if (envelope?.version !== 1 || envelope?.algorithm !== ALGORITHM) throw new Error('Encrypted credential format is unsupported.');
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    throw new Error('Credential decryption failed; the key may be incorrect or the file may be damaged.');
  }
}

export function createAccountMetadata({ username, email, status, createdAt = new Date().toISOString() }) {
  if (!/^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/i.test(username ?? '')) throw new TypeError('Username has an invalid format.');
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TypeError('Email has an invalid format.');
  if (!ALLOWED_STATUSES.has(status)) throw new TypeError('Account status is not supported.');
  if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError('createdAt must be an ISO-compatible timestamp.');
  return {
    platform: 'instagram',
    username,
    email,
    status,
    createdAt,
    verificationMethod: 'email',
    credentialsFile: `${username}.enc`,
  };
}

export function validateAccountMetadata(metadata) {
  if (!metadata || metadata.platform !== 'instagram') return false;
  if (!/^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/i.test(metadata.username ?? '')) return false;
  if (typeof metadata.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(metadata.email)) return false;
  if (!ALLOWED_STATUSES.has(metadata.status)) return false;
  if (!Number.isFinite(Date.parse(metadata.createdAt))) return false;
  if (metadata.verificationMethod !== 'email') return false;
  return metadata.credentialsFile === `${metadata.username}.enc`;
}

export async function verifyEncryptedStorage(encryptionKey, directory = path.resolve('accounts')) {
  decodeEncryptionKey(encryptionKey);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let probeDirectory;
  try {
    probeDirectory = await mkdtemp(path.join(directory, '.preflight-'));
    const probePath = path.join(probeDirectory, 'credential-probe.enc');
    const probe = { purpose: 'storage-preflight', nonce: randomBytes(16).toString('hex') };
    const handle = await open(probePath, 'wx', 0o600);
    try { await handle.writeFile(encryptCredentials(probe, encryptionKey), 'utf8'); } finally { await handle.close(); }
    const restored = decryptCredentials(await readFile(probePath, 'utf8'), encryptionKey);
    if (restored.purpose !== probe.purpose || restored.nonce !== probe.nonce) throw new Error('round trip mismatch');
  } catch {
    throw new Error('Secure account storage preflight failed: encrypted write/read verification was unsuccessful.');
  } finally {
    if (probeDirectory) await rm(probeDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function saveEncryptedCredentials({ username, credentials, encryptionKey, directory = path.resolve('accounts') }) {
  if (!/^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/i.test(username ?? '')) throw new TypeError('Username has an invalid format.');
  const encryptedText = encryptCredentials(credentials, encryptionKey);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const credentialPath = path.join(directory, `${username}.enc`);
  let credentialCreated = false;
  try {
    const handle = await open(credentialPath, 'wx', 0o600);
    credentialCreated = true;
    try { await handle.writeFile(encryptedText, 'utf8'); } finally { await handle.close(); }
    return { credentialPath };
  } catch (error) {
    if (credentialCreated) await unlink(credentialPath).catch(() => {});
    throw new Error(`Secure credential persistence failed: ${error.code === 'EEXIST' ? 'an account file already exists for this username' : 'a protected file could not be written'}`);
  }
}

export async function saveAccount({ username, email, status, credentials, encryptionKey, directory = path.resolve('accounts'), createdAt }) {
  const metadata = createAccountMetadata({ username, email, status, createdAt });
  const encryptedText = encryptCredentials(credentials, encryptionKey);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadataPath = path.join(directory, `${username}.json`);
  const credentialPath = path.join(directory, `${username}.enc`);
  let credentialCreated = false;
  let metadataCreated = false;
  try {
    const credentialHandle = await open(credentialPath, 'wx', 0o600);
    credentialCreated = true;
    try { await credentialHandle.writeFile(encryptedText, 'utf8'); } finally { await credentialHandle.close(); }
    const metadataHandle = await open(metadataPath, 'wx', 0o600);
    metadataCreated = true;
    try { await metadataHandle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'); } finally { await metadataHandle.close(); }
    return { metadata, metadataPath, credentialPath };
  } catch (error) {
    if (credentialCreated) await unlink(credentialPath).catch(() => {});
    if (metadataCreated) await unlink(metadataPath).catch(() => {});
    throw new Error(`Secure account persistence failed: ${error.code === 'EEXIST' ? 'an account file already exists for this username' : 'a protected file could not be written'}`);
  }
}

export async function readEncryptedCredentials(filePath, encodedKey) {
  return decryptCredentials(await readFile(filePath, 'utf8'), encodedKey);
}
