// Password and API key hashes, session tokens and cookies.
// Web Crypto only: no dependencies.

const encoder = new TextEncoder();

/** Names of the environment secrets. Only the owner of the installation sets their values. */
export const SECRET_ROOT = "GATEFOLD_ROOT_PASSWORD";
export const SECRET_MASTER = "GATEFOLD_MASTER_KEY";
export const SECRET_SIGNING = "GATEFOLD_SIGNING_KEY";

/** PBKDF2 rounds. Stored in each hash, so it can be raised without invalidating old passwords. */
const PASSWORD_ROUNDS = 50_000;

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Random identifier, impossible to guess. */
export function randomId(bytes = 16): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hmac(key: string, data: string | Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, typeof data === "string" ? encoder.encode(data) : data);
}

/** Compares without revealing, through timing, where the strings differ. */
export async function safeEqual(left: string, right: string): Promise<boolean> {
  const key = randomId();
  const a = new Uint8Array(await hmac(key, left));
  const b = new Uint8Array(await hmac(key, right));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

async function stretch(masterKey: string, password: string, salt: Uint8Array<ArrayBuffer>, rounds: number): Promise<string> {
  // The master key goes in before PBKDF2: without it, the database alone is not enough to test passwords.
  const peppered = await hmac(masterKey, `password:${password}`);
  const material = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, material, 256);
  return base64url(bits);
}

export async function hashPassword(masterKey: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PASSWORD_ROUNDS}$${base64url(salt)}$${await stretch(masterKey, password, salt, PASSWORD_ROUNDS)}`;
}

/**
 * Checks the password. With a null `stored` (no such user) it does the same
 * work and refuses, so the response time does not reveal which users exist.
 */
export async function verifyPassword(masterKey: string, password: string, stored: string | null): Promise<boolean> {
  const [scheme, rounds, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "pbkdf2" || !salt || !hash || !/^\d+$/.test(rounds ?? "")) {
    await stretch(masterKey, password, new Uint8Array(16), PASSWORD_ROUNDS);
    return false;
  }
  return safeEqual(await stretch(masterKey, password, fromBase64url(salt), Number(rounds)), hash);
}

/** A new API key. The prefix says whose it is: `cn_a_` administrator, `cn_r_` reader. */
export function newApiKey(role: Role): string {
  return `cn_${role === "admin" ? "a" : "r"}_${randomId(32)}`;
}

/** The key is already long and random: an HMAC with the master key is enough, and can be looked up. */
export async function hashApiKey(masterKey: string, key: string): Promise<string> {
  return base64url(await hmac(masterKey, `api-key:${key}`));
}

/**
 * What a count of attempts is kept under (see throttle.ts). A name that was
 * typed may be a password typed into the wrong field: it is never stored as it is.
 */
export async function hashAttempt(masterKey: string, subject: string): Promise<string> {
  return base64url(await hmac(masterKey, `attempt:${subject}`)).slice(0, 22);
}

/** The token of a reader's access link (`/reader/invite/<token>`). As long and random as an API key. */
export function newInviteToken(): string {
  return randomId(32);
}

export async function hashInvite(masterKey: string, token: string): Promise<string> {
  return base64url(await hmac(masterKey, `invite:${token}`));
}

// ---------------------------------------------------------------------------
// Session token (JWT, HS256)
// ---------------------------------------------------------------------------

export type Role = "admin" | "reader";

export interface Claims {
  /** Session identifier in the database. */
  sid: string;
  /** User identifier. */
  sub: string;
  role: Role;
  /** Expiry, in seconds since 1970 (the JWT standard). */
  exp: number;
}

const JWT_HEADER = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

export async function signToken(signingKey: string, claims: Claims): Promise<string> {
  const body = `${JWT_HEADER}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  return `${body}.${base64url(await hmac(signingKey, body))}`;
}

/** The token's claims, or `null` if the signature, the format or the expiry does not check out. */
export async function verifyToken(signingKey: string, token: string, now: number): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== JWT_HEADER) return null;
  if (!(await safeEqual(base64url(await hmac(signingKey, `${parts[0]}.${parts[1]}`)), parts[2]!))) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]!))) as Partial<Claims>;
    if (typeof claims.sid !== "string" || typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.role !== "admin" && claims.role !== "reader") return null;
    if (claims.exp * 1000 <= now) return null;
    return claims as Claims;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/** One cookie per role: the same person can be signed in as administrator and as reader. */
export function cookieName(role: Role): string {
  return role === "admin" ? "gatefold_admin" : "gatefold_reader";
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** `Lax`: another site cannot submit forms with the cookie, but a link to a private source still works. */
export function sessionCookie(role: Role, token: string, maxAgeSeconds: number): string {
  return `${cookieName(role)}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(role: Role): string {
  return `${cookieName(role)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// Two-step verification: the 6-digit codes of an authenticator app (TOTP, RFC 6238)
// ---------------------------------------------------------------------------

/** How long each code lasts. Every authenticator app assumes 30 seconds. */
export const MFA_STEP_MS = 30_000;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function toBase32(bytes: Uint8Array): string {
  let text = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += BASE32[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  return bits > 0 ? text + BASE32[(value << (5 - bits)) & 31] : text;
}

function fromBase32(text: string): Uint8Array<ArrayBuffer> | null {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const letter of text) {
    const index = BASE32.indexOf(letter);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(bytes);
}

/** The key an administrator adds to their authenticator app: 160 random bits, as 32 letters and digits. */
export function newMfaSecret(): string {
  return toBase32(crypto.getRandomValues(new Uint8Array(20)));
}

/** The code the app shows during the 30-second `step` (the number of steps since 1970). */
export async function mfaCode(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromBase32(secret) ?? new Uint8Array(1), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new DataView(new ArrayBuffer(8));
  counter.setUint32(0, Math.floor(step / 2 ** 32));
  counter.setUint32(4, step >>> 0);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const at = digest[19]! & 15;
  const number = ((digest[at]! & 127) << 24) | (digest[at + 1]! << 16) | (digest[at + 2]! << 8) | digest[at + 3]!;
  return String(number % 1_000_000).padStart(6, "0");
}

/**
 * The step whose code was typed, or `null` when the code is wrong. The step
 * before and the step after are accepted too: phones and servers do not agree
 * on the time to the second, and a code takes a moment to type.
 */
export async function matchMfaCode(secret: string, code: string, now: number): Promise<number | null> {
  const current = Math.floor(now / MFA_STEP_MS);
  let matched: number | null = null;
  // Every candidate is compared, so the time taken does not say which one matched.
  for (const step of [current - 1, current, current + 1]) {
    if ((await safeEqual(await mfaCode(secret, step), code)) && matched === null) matched = step;
  }
  return matched;
}

/** What an authenticator app reads to add the account: the key, and the names it shows beside the codes. */
export function mfaUrl(issuer: string, username: string, secret: string): string {
  const name = issuer.replace(/:/g, " ");
  return `otpauth://totp/${encodeURIComponent(`${name}:${username}`)}?secret=${secret}&issuer=${encodeURIComponent(name)}`;
}

async function sealingKey(masterKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await hmac(masterKey, "mfa-secret"), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * The key of an authenticator app has to be read back to check a code, so it
 * cannot be stored as a hash. It is stored encrypted with the master key:
 * the database alone is not enough to make codes. `owner` ties it to one
 * account, so a stored value copied to another account does not open.
 */
export async function sealMfaSecret(masterKey: string, secret: string, owner: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(owner) }, await sealingKey(masterKey), encoder.encode(secret));
  return `v1.${base64url(iv)}.${base64url(sealed)}`;
}

/** The key as it was sealed, or `null` if the stored value does not open (another master key, another account). */
export async function openMfaSecret(masterKey: string, stored: string, owner: string): Promise<string | null> {
  const [version, iv, sealed] = stored.split(".");
  if (version !== "v1" || !iv || !sealed) return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv), additionalData: encoder.encode(owner) }, await sealingKey(masterKey), fromBase64url(sealed),
    );
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}
