import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, createCipheriv, randomBytes } from 'node:crypto';
import { decryptCookieValue, queryCookiesFromBuffer } from '../src/chrome-cookies.js';

function encryptLikeChrome(plaintext: string, password = 'test-password'): { encrypted: Buffer; key: Buffer } {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const encrypted = Buffer.concat([Buffer.from('v10'), ciphertext]);
  return { encrypted, key };
}

function encryptLikeChromeWindows(plaintext: string): { encrypted: Buffer; key: Buffer } {
  const key = randomBytes(32); // AES-256 key
  const nonce = randomBytes(12); // 12-byte GCM nonce
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes
  // Windows format: 'v10' + nonce(12) + ciphertext(N) + authTag(16)
  const encrypted = Buffer.concat([Buffer.from('v10'), nonce, ciphertext, authTag]);
  return { encrypted, key };
}

test('decryptCookieValue: decrypts v10-prefixed Chrome cookie', () => {
  const { encrypted, key } = encryptLikeChrome('my-secret-csrf-token');
  const result = decryptCookieValue(encrypted, key, 0, 'darwin');
  assert.equal(result, 'my-secret-csrf-token');
});

test('decryptCookieValue: returns empty string for empty buffer', () => {
  const key = pbkdf2Sync('test', 'saltysalt', 1003, 16, 'sha1');
  const result = decryptCookieValue(Buffer.alloc(0), key, 0, 'darwin');
  assert.equal(result, '');
});

test('decryptCookieValue: returns raw utf8 for non-v10 prefix (unencrypted)', () => {
  const key = pbkdf2Sync('test', 'saltysalt', 1003, 16, 'sha1');
  const buf = Buffer.from('plain-cookie-value', 'utf8');
  const result = decryptCookieValue(buf, key, 0, 'darwin');
  assert.equal(result, 'plain-cookie-value');
});

test('decryptCookieValue: round-trips various cookie values', () => {
  const values = [
    'abc123',
    'a-much-longer-csrf-token-that-is-over-16-bytes-long-and-needs-multiple-blocks',
    '特殊文字',
    '{"json":"value"}',
  ];
  for (const value of values) {
    const { encrypted, key } = encryptLikeChrome(value);
    const result = decryptCookieValue(encrypted, key, 0, 'darwin');
    assert.equal(result, value, `Round-trip failed for: ${value}`);
  }
});

test('decryptCookieValue: uses correct PBKDF2 parameters (1003 iterations, sha1, saltysalt)', () => {
  const password = 'Chrome-Safe-Storage-Password';
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const { encrypted } = encryptLikeChrome('test-value', password);
  const result = decryptCookieValue(encrypted, key, 0, 'darwin');
  assert.equal(result, 'test-value');
});

test('decryptCookieValue: decrypts Windows v10 AES-256-GCM cookie', () => {
  const { encrypted, key } = encryptLikeChromeWindows('my-windows-csrf-token');
  const result = decryptCookieValue(encrypted, key, 0, 'win32');
  assert.equal(result, 'my-windows-csrf-token');
});

test('decryptCookieValue: round-trips various values with Windows GCM', () => {
  const values = [
    'abc123',
    'a-much-longer-csrf-token-that-is-over-16-bytes-long-and-needs-multiple-blocks',
    '{"json":"value"}',
  ];
  for (const value of values) {
    const { encrypted, key } = encryptLikeChromeWindows(value);
    const result = decryptCookieValue(encrypted, key, 0, 'win32');
    assert.equal(result, value, `GCM round-trip failed for: ${value}`);
  }
});

test('decryptCookieValue: Mac CBC path still works when platform is darwin', () => {
  const { encrypted, key } = encryptLikeChrome('mac-cookie-value');
  const result = decryptCookieValue(encrypted, key, 0, 'darwin');
  assert.equal(result, 'mac-cookie-value');
});

test('queryCookiesFromBuffer: reads cookies from an in-memory SQLite db', async () => {
  // Build a minimal Chrome Cookies database in memory
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const initSqlJs = req('sql.js-fts5') as (opts: any) => Promise<any>;
  const wasmPath = req.resolve('sql.js-fts5/dist/sql-wasm.wasm');
  const wasmBinary = (await import('node:fs')).readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();

  db.run(`CREATE TABLE meta (key TEXT, value TEXT)`);
  db.run(`INSERT INTO meta VALUES ('version', '24')`);
  db.run(`CREATE TABLE cookies (
    name TEXT, host_key TEXT, encrypted_value BLOB, value TEXT
  )`);
  db.run(
    `INSERT INTO cookies VALUES (?, ?, ?, ?)`,
    ['ct0', '.x.com', Buffer.from('test-encrypted-value'), '']
  );
  db.run(
    `INSERT INTO cookies VALUES (?, ?, ?, ?)`,
    ['auth_token', '.x.com', Buffer.from('test-auth-value'), '']
  );

  const exported = Buffer.from(db.export());
  db.close();

  const result = await queryCookiesFromBuffer(exported, '.x.com', ['ct0', 'auth_token']);
  assert.equal(result.cookies.length, 2);
  assert.equal(result.dbVersion, 24);
  assert.equal(result.cookies[0].name, 'ct0');
  assert.ok(result.cookies[0].encrypted_value instanceof Buffer);
});
