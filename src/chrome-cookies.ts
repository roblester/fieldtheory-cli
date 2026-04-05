import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { pbkdf2Sync, createDecipheriv, randomUUID } from 'node:crypto';

export interface ChromeCookieResult {
  csrfToken: string;
  cookieHeader: string;
}

function getMacOSChromeKey(): Buffer {
  const candidates = [
    { service: 'Chrome Safe Storage', account: 'Chrome' },
    { service: 'Chrome Safe Storage', account: 'Google Chrome' },
    { service: 'Google Chrome Safe Storage', account: 'Chrome' },
    { service: 'Google Chrome Safe Storage', account: 'Google Chrome' },
    { service: 'Chromium Safe Storage', account: 'Chromium' },
    { service: 'Brave Safe Storage', account: 'Brave' },
    { service: 'Brave Browser Safe Storage', account: 'Brave Browser' },
  ];

  for (const candidate of candidates) {
    try {
      const password = execFileSync(
        'security',
        ['find-generic-password', '-w', '-s', candidate.service, '-a', candidate.account],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (password) {
        return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
      }
    } catch {
      // Try the next known browser/keychain naming pair.
    }
  }

  throw new Error(
    'Could not read a browser Safe Storage password from the macOS Keychain.\n' +
    'This is needed to decrypt Chrome-family cookies.\n' +
    'Fix: open the browser profile that is logged into X, then retry.\n' +
    'If you already use the API flow, prefer: ft sync --api'
  );
}

function getWindowsChromeKey(chromeUserDataDir: string): Buffer {
  const localStatePath = join(chromeUserDataDir, 'Local State');
  if (!existsSync(localStatePath)) {
    throw new Error(
      `Chrome Local State file not found at: ${localStatePath}\n` +
      'Fix: Make sure Google Chrome is installed and has been opened at least once.'
    );
  }

  const localState = JSON.parse(readFileSync(localStatePath, 'utf8'));
  const encryptedKeyB64 = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) {
    throw new Error(
      'Could not find os_crypt.encrypted_key in Chrome Local State.\n' +
      'Fix: Make sure you are using a recent version of Google Chrome.'
    );
  }

  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
  // Strip the 'DPAPI' prefix (5 bytes: 0x44 0x50 0x41 0x50 0x49)
  if (encryptedKey.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('Chrome encrypted key does not have expected DPAPI prefix.');
  }
  const dpapiBlobB64 = encryptedKey.subarray(5).toString('base64');

  // Use PowerShell to call CryptUnprotectData via .NET's ProtectedData class
  const psScript = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${dpapiBlobB64}')
$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($decrypted)
`.trim();

  let output: string;
  try {
    output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();
  } catch (err: any) {
    throw new Error(
      'Failed to decrypt Chrome master key via DPAPI.\n' +
      `PowerShell error: ${err.message}\n` +
      'Fix: Make sure you are running this as the same Windows user who owns the Chrome profile.'
    );
  }

  const key = Buffer.from(output, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `Decrypted Chrome key is ${key.length} bytes, expected 32.\n` +
      'This may indicate a corrupted Local State file or an unsupported Chrome version.'
    );
  }

  return key;
}

function sanitizeCookieValue(name: string, value: string): string {
  const cleaned = value.replace(/\0+$/g, '').trim();
  if (!cleaned) {
    throw new Error(
      `Cookie ${name} was empty after decryption.\n\n` +
      'This usually happens when Chrome is open. Try:\n' +
      '  1. Close Chrome completely and run ft sync again\n' +
      '  2. If that doesn\'t work, try a different profile:\n' +
      '     ft sync --chrome-profile-directory "Profile 1"\n' +
      '  3. Or use the API method instead:\n' +
      '     ft auth && ft sync --api'
    );
  }
  if (!/^[\x21-\x7E]+$/.test(cleaned)) {
    throw new Error(
      `Could not decrypt the ${name} cookie.\n\n` +
      'This usually happens when Chrome is open or the wrong profile is selected.\n\n' +
      'Try:\n' +
      '  1. Close Chrome completely and run ft sync again\n' +
      '  2. Try a different profile:\n' +
      '     ft sync --chrome-profile-directory "Profile 1"\n' +
      '  3. Or use the API method instead:\n' +
      '     ft auth && ft sync --api'
    );
  }
  return cleaned;
}

export function decryptCookieValue(encryptedValue: Buffer, key: Buffer, dbVersion = 0, platformOverride?: string): string {
  if (encryptedValue.length === 0) return '';

  const os = platformOverride ?? platform();
  const isV10 = encryptedValue[0] === 0x76 && encryptedValue[1] === 0x31 && encryptedValue[2] === 0x30;

  if (isV10 && os === 'win32') {
    // Windows: AES-256-GCM
    // Layout: 'v10'(3) + nonce(12) + ciphertext(N) + authTag(16)
    const nonce = encryptedValue.subarray(3, 15);
    const authTag = encryptedValue.subarray(encryptedValue.length - 16);
    const ciphertext = encryptedValue.subarray(15, encryptedValue.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // Chrome DB version >= 24 (Chrome ~130+) prepends SHA256(host_key) to plaintext
    if (dbVersion >= 24 && decrypted.length > 32) {
      decrypted = decrypted.subarray(32);
    }

    return decrypted.toString('utf8');
  }

  if (isV10) {
    // macOS: AES-128-CBC
    const iv = Buffer.alloc(16, 0x20);
    const ciphertext = encryptedValue.subarray(3);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // Chrome DB version >= 24 (Chrome ~130+) prepends SHA256(host_key) to plaintext
    if (dbVersion >= 24 && decrypted.length > 32) {
      decrypted = decrypted.subarray(32);
    }

    return decrypted.toString('utf8');
  }

  return encryptedValue.toString('utf8');
}

interface CookieQueryResult {
  cookies: Array<{ name: string; host_key: string; encrypted_value: Buffer; value: string }>;
  dbVersion: number;
}

export async function queryCookiesFromBuffer(
  dbBuffer: Buffer,
  domain: string,
  names: string[]
): Promise<CookieQueryResult> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const initSqlJs = require('sql.js-fts5') as (opts: any) => Promise<any>;
  const wasmPath = require.resolve('sql.js-fts5/dist/sql-wasm.wasm');
  const wasmBinary = (await import('node:fs')).readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database(dbBuffer);

  let dbVersion = 0;
  try {
    const metaRows = db.exec("SELECT value FROM meta WHERE key='version'");
    if (metaRows.length > 0 && metaRows[0].values.length > 0) {
      dbVersion = parseInt(String(metaRows[0].values[0][0]), 10) || 0;
    }
  } catch { /* meta table may not exist */ }

  const nameParams = names.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT name, host_key, encrypted_value, value FROM cookies WHERE host_key LIKE ? AND name IN (${nameParams})`
  );
  try {
    stmt.bind([`%${domain}`, ...names]);

    const cookies: CookieQueryResult['cookies'] = [];
    while (stmt.step()) {
      const row = stmt.get();
      cookies.push({
        name: row[0] as string,
        host_key: row[1] as string,
        encrypted_value: Buffer.from(row[2] as Uint8Array),
        value: (row[3] as string) ?? '',
      });
    }

    return { cookies, dbVersion };
  } finally {
    stmt.free();
    db.close();
  }
}

export async function extractChromeXCookies(
  chromeUserDataDir: string,
  profileDirectory = 'Default'
): Promise<ChromeCookieResult> {
  const os = platform();

  let key: Buffer;
  if (os === 'darwin') {
    key = getMacOSChromeKey();
  } else if (os === 'win32') {
    key = getWindowsChromeKey(chromeUserDataDir);
  } else {
    throw new Error(
      `Direct cookie extraction is currently supported on macOS and Windows.\n` +
      `Detected platform: ${os}\n` +
      'Fix: Pass --csrf-token and --cookie-header directly, or contribute Linux support.'
    );
  }

  const dbPath = join(chromeUserDataDir, profileDirectory, 'Cookies');
  if (!existsSync(dbPath)) {
    throw new Error(
      `Chrome Cookies database not found at: ${dbPath}\n` +
      'Fix: Make sure Google Chrome is installed and has been opened at least once.\n' +
      'If you use a non-default Chrome profile, pass --chrome-profile-directory <name>.'
    );
  }

  // Read the Cookies DB into memory via sql.js (cross-platform, avoids sqlite3 CLI)
  let dbBuffer: Buffer;
  try {
    dbBuffer = readFileSync(dbPath);
  } catch {
    // DB may be locked by Chrome — try a copy
    const tmpDb = join(tmpdir(), `ft-cookies-${randomUUID()}.db`);
    try {
      copyFileSync(dbPath, tmpDb);
      dbBuffer = readFileSync(tmpDb);
    } catch (e2: any) {
      throw new Error(
        `Could not read Chrome Cookies database.\n` +
        `Path: ${dbPath}\n` +
        `Error: ${e2.message}\n` +
        'Fix: If Chrome is open, close it and retry. The database may be locked.'
      );
    } finally {
      try { unlinkSync(tmpDb); } catch {}
    }
  }

  let result = await queryCookiesFromBuffer(dbBuffer, '.x.com', ['ct0', 'auth_token']);
  if (result.cookies.length === 0) {
    result = await queryCookiesFromBuffer(dbBuffer, '.twitter.com', ['ct0', 'auth_token']);
  }

  const decrypted = new Map<string, string>();
  for (const cookie of result.cookies) {
    if (cookie.encrypted_value && cookie.encrypted_value.length > 0) {
      decrypted.set(cookie.name, decryptCookieValue(cookie.encrypted_value, key, result.dbVersion, os));
    } else if (cookie.value) {
      decrypted.set(cookie.name, cookie.value);
    }
  }

  const ct0 = decrypted.get('ct0');
  const authToken = decrypted.get('auth_token');

  if (!ct0) {
    throw new Error(
      'No ct0 CSRF cookie found for x.com in Chrome.\n' +
      'This means you are not logged into X in Chrome.\n\n' +
      'Fix:\n' +
      '  1. Open Google Chrome\n' +
      '  2. Go to https://x.com and log in\n' +
      '  3. Re-run this command\n\n' +
      (profileDirectory !== 'Default'
        ? `Using Chrome profile: "${profileDirectory}"\n`
        : 'Using the Default Chrome profile. If your X login is in a different profile,\n' +
          'pass --chrome-profile-directory <name> (e.g., "Profile 1").\n')
    );
  }

  const cookieParts = [`ct0=${sanitizeCookieValue('ct0', ct0)}`];
  if (authToken) cookieParts.push(`auth_token=${sanitizeCookieValue('auth_token', authToken)}`);
  const cookieHeader = cookieParts.join('; ');

  return { csrfToken: sanitizeCookieValue('ct0', ct0), cookieHeader };
}
