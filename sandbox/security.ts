// Resumos de senha e de chave de API, tokens de sessão e cookies (seed.md, seção 9).
// Só usa a Web Crypto: nenhuma dependência.

const encoder = new TextEncoder();

/** Nomes dos segredos do ambiente. Os valores só o dono da instalação define. */
export const SECRET_ROOT = "CANONE_ROOT_PASSWORD";
export const SECRET_MASTER = "CANONE_MASTER_KEY";
export const SECRET_SIGNING = "CANONE_SIGNING_KEY";

/** Voltas do PBKDF2. Fica gravado em cada resumo, então pode subir sem invalidar senhas antigas. */
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

/** Identificador aleatório, impossível de adivinhar (seção 10, convenções). */
export function randomId(bytes = 16): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hmac(key: string, data: string | Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, typeof data === "string" ? encoder.encode(data) : data);
}

/** Compara sem revelar, pelo tempo gasto, em que ponto os textos diferem. */
export async function safeEqual(left: string, right: string): Promise<boolean> {
  const key = randomId();
  const a = new Uint8Array(await hmac(key, left));
  const b = new Uint8Array(await hmac(key, right));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

async function stretch(masterKey: string, password: string, salt: Uint8Array<ArrayBuffer>, rounds: number): Promise<string> {
  // A chave mestra entra antes do PBKDF2: sem ela, o banco sozinho não permite testar senhas.
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
 * Confere a senha. Com `stored` nulo (usuário inexistente) faz o mesmo trabalho
 * e recusa, para que o tempo de resposta não revele quais usuários existem.
 */
export async function verifyPassword(masterKey: string, password: string, stored: string | null): Promise<boolean> {
  const [scheme, rounds, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "pbkdf2" || !salt || !hash || !/^\d+$/.test(rounds ?? "")) {
    await stretch(masterKey, password, new Uint8Array(16), PASSWORD_ROUNDS);
    return false;
  }
  return safeEqual(await stretch(masterKey, password, fromBase64url(salt), Number(rounds)), hash);
}

/** Chave de API nova. O prefixo diz de quem é: `cn_a_` administrador, `cn_r_` leitor. */
export function newApiKey(role: Role): string {
  return `cn_${role === "admin" ? "a" : "r"}_${randomId(32)}`;
}

/** A chave já é aleatória e longa: um HMAC com a chave mestra basta, e permite procurar por ele. */
export async function hashApiKey(masterKey: string, key: string): Promise<string> {
  return base64url(await hmac(masterKey, `api-key:${key}`));
}

// ---------------------------------------------------------------------------
// Token de sessão (JWT, HS256)
// ---------------------------------------------------------------------------

export type Role = "admin" | "reader";

export interface Claims {
  /** Identificador da sessão no banco. */
  sid: string;
  /** Identificador do usuário. */
  sub: string;
  role: Role;
  /** Validade, em segundos desde 1970 (padrão do JWT). */
  exp: number;
}

const JWT_HEADER = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

export async function signToken(signingKey: string, claims: Claims): Promise<string> {
  const body = `${JWT_HEADER}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  return `${body}.${base64url(await hmac(signingKey, body))}`;
}

/** As informações do token, ou `null` se a assinatura, o formato ou a validade não conferem. */
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

/** Um cookie por papel: a mesma pessoa pode estar logada como administrador e como leitor. */
export function cookieName(role: Role): string {
  return role === "admin" ? "canone_admin" : "canone_reader";
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** `Lax`: outro site não consegue enviar formulários com o cookie, mas um link para uma fonte privada funciona. */
export function sessionCookie(role: Role, token: string, maxAgeSeconds: number): string {
  return `${cookieName(role)}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(role: Role): string {
  return `${cookieName(role)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Proteção contra requisições forjadas por outro site (seção 12, item 9): uma
 * alteração feita com cookie só vale se o navegador disser que partiu deste site.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === new URL(request.url).origin;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}
