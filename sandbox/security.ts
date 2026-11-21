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

/**
 * Protection against requests forged by another site (CSRF): a change made
 * with a cookie only counts if the browser says it came from this site.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === new URL(request.url).origin;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}
