import { blankBook, validateBook } from './model.js';

const TYPE = 'curbquill-web-encrypted-v1';
const ITERATIONS = 600000;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });
const DB_NAME = 'curbquill-web-vault:' + new URL('./', import.meta.url).pathname;
const STORE = 'vault';
const ENTRY = 'record-book';
export const BACKUP_BYTES = 52_000_000;
const PLAINTEXT_BYTES = 38_000_000;

function base64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

function unbase64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function envelopeFields(envelope) {
  if (!envelope || envelope.type !== TYPE || envelope.iterations !== ITERATIONS ||
    typeof envelope.salt !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(envelope.salt) ||
    typeof envelope.iv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(envelope.iv) ||
    typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length < 24 ||
    envelope.ciphertext.length > BACKUP_BYTES) throw new Error('Choose a supported CurbQuill encrypted backup.');
  return { type: TYPE, iterations: ITERATIONS, salt: envelope.salt };
}

async function derive(password, salt) {
  if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('Enter the vault password.');
  const bytes = ENCODER.encode(password);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({
      name: 'PBKDF2', salt: unbase64(salt), iterations: ITERATIONS, hash: 'SHA-256'
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    bytes.fill(0);
  }
}

export async function seal(book, key, salt) {
  const header = { type: TYPE, iterations: ITERATIONS, salt };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = ENCODER.encode(JSON.stringify(validateBook(book)));
  try {
    if (clear.length > PLAINTEXT_BYTES) throw new Error('The vault exceeds its storage size limit. The previous data is preserved.');
    const bytes = await crypto.subtle.encrypt({
      name: 'AES-GCM', iv, additionalData: ENCODER.encode(JSON.stringify(header))
    }, key, clear);
    return { ...header, iv: base64(iv), ciphertext: base64(new Uint8Array(bytes)) };
  } finally {
    clear.fill(0);
  }
}

export async function openEnvelope(envelope, password) {
  const header = envelopeFields(envelope);
  const key = await derive(password, header.salt);
  let clear;
  try {
    clear = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: unbase64(envelope.iv), additionalData: ENCODER.encode(JSON.stringify(header))
    }, key, unbase64(envelope.ciphertext)));
  } catch {
    throw new Error('The password did not unlock the vault, or the encrypted file is damaged.');
  }
  try {
    if (clear.length > PLAINTEXT_BYTES) throw new Error('This vault exceeds the supported size.');
    return { book: validateBook(JSON.parse(DECODER.decode(clear))), key, salt: header.salt };
  } finally {
    clear.fill(0);
  }
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(new Error('Browser storage is unavailable. Use a regular browser window with site storage enabled.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export function readVault(db) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(ENTRY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('Could not read the local vault.'));
  });
}

export function writeVault(db, expectedRevision, envelope) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const store = tx.objectStore(STORE);
    const request = store.get(ENTRY);
    const nextRevision = expectedRevision + 1;
    let error;
    request.onsuccess = () => {
      if ((request.result?.revision || 0) !== expectedRevision) {
        error = new Error('Another window saved a change. Lock and unlock to reopen the latest book.');
        tx.abort();
        return;
      }
      store.put({ revision: nextRevision, envelope }, ENTRY);
    };
    tx.oncomplete = () => resolve(nextRevision);
    tx.onabort = () => reject(error || new Error('The vault could not be saved. The previous data is preserved.'));
  });
}

export async function createVault(db, password) {
  if (Array.from(password).length < 12) throw new Error('Use at least 12 characters for the vault password.');
  const salt = base64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await derive(password, salt);
  const book = blankBook();
  const envelope = await seal(book, key, salt);
  const revision = await writeVault(db, 0, envelope);
  return { book, key, salt, revision };
}

export async function readLocalFile(file, maxBytes) {
  if (!file || !file.size || file.size > maxBytes) throw new Error('Choose a nonempty file under ' + Math.floor(maxBytes / 1_000_000) + ' MB.');
  try {
    return DECODER.decode(await file.arrayBuffer());
  } catch {
    throw new Error('Could not read the file as valid UTF-8.');
  }
}
