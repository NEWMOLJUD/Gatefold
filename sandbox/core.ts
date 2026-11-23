// The core of Gatefold: database schema, authentication and the operations the
// pages and the API share. No route is defined here.
import type { Database, SqlParam, SqlValue } from "../deps/databases.ts";
import type { Files } from "../deps/files.ts";
import type { Secrets } from "../deps/secrets.ts";
import type { Sites } from "../deps/sites.ts";
import { type Actor, type AuditEntry, type Found, hourOf, record, recordAs, recordFound, recordOnce, recordTally, rootActor, toAuditEntry, visitor } from "./audit.ts";
import { type Config, clientIp, publicOrigin, sameOrigin } from "./config.ts";
import {
  type Claims, type Role, SECRET_MASTER, SECRET_ROOT, SECRET_SIGNING, clearCookie, cookieName, hashApiKey, hashAttempt, hashInvite, hashPassword,
  matchMfaCode, newApiKey, newInviteToken, newMfaSecret, openMfaSecret, randomId, readCookie, safeEqual, sealMfaSecret, sessionCookie, signToken, verifyPassword, verifyToken,
} from "./security.ts";
import { contentTypeOf } from "./mime.ts";
import { DEFAULT_RENDER, MAX_PROPS, SOURCES_FOLDER, SOURCE_CONFIG, loadSourceConfig } from "./source-config.ts";
import { type Limit, cleanupAttempts, countAttempts, forgetAttempts, overLimit, readAttempts, uncountAttempts } from "./throttle.ts";

/**
 * Schema history. Once published, no statement is edited or removed: every
 * change is appended as a new statement at the end.
 */
export const MIGRATIONS = [
  `CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
  `CREATE TABLE readers (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props)),
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX readers_created_at ON readers (created_at)`,
  `CREATE TABLE sources (
  alias TEXT PRIMARY KEY,
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  props TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props)),
  render TEXT NOT NULL DEFAULT '["html"]' CHECK (json_valid(render)),
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX sources_created_at ON sources (created_at)`,
  `CREATE TABLE permissions (
  reader_id TEXT NOT NULL REFERENCES readers (id) ON DELETE CASCADE,
  source_alias TEXT NOT NULL REFERENCES sources (alias) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (reader_id, source_alias)
)`,
  `CREATE INDEX permissions_source ON permissions (source_alias)`,
  `CREATE TABLE platform (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  props TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props)),
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT REFERENCES admins (id) ON DELETE CASCADE,
  reader_id TEXT REFERENCES readers (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK ((admin_id IS NULL) <> (reader_id IS NULL))
)`,
  `CREATE INDEX sessions_admin ON sessions (admin_id)`,
  `CREATE INDEX sessions_reader ON sessions (reader_id)`,
  `CREATE INDEX sessions_expires_at ON sessions (expires_at)`,
  `CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  admin_id TEXT REFERENCES admins (id) ON DELETE CASCADE,
  reader_id TEXT REFERENCES readers (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK ((admin_id IS NULL) <> (reader_id IS NULL))
)`,
  `CREATE INDEX api_keys_admin ON api_keys (admin_id)`,
  `CREATE INDEX api_keys_reader ON api_keys (reader_id)`,
  `CREATE TABLE root_attempts (
  hour INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL
)`,
  // Readers are created with an email and choose their own password through a
  // link: until they do, `password_hash` is empty and nobody can sign in as them.
  `ALTER TABLE readers ADD COLUMN email TEXT`,
  `CREATE UNIQUE INDEX readers_email ON readers (email)`,
  `CREATE TABLE invites (
  reader_id TEXT PRIMARY KEY REFERENCES readers (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`,
  // Every change made to the database. Rows are only added: see audit.ts.
  `CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_role TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  via TEXT NOT NULL,
  ip TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_name TEXT,
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details))
)`,
  `CREATE INDEX audit_log_at ON audit_log (at)`,
  `CREATE INDEX audit_log_action ON audit_log (action, id)`,
  `CREATE INDEX audit_log_actor ON audit_log (actor_name, id)`,
  // Usernames are unique whatever their case: "Ana" and "ana" are the same person
  // to whoever reads a list. If an installation already has two that differ only
  // by case, the newer one gets a suffix before the rule starts to hold.
  ...["admins", "readers"].flatMap((table) => [
    `UPDATE ${table} SET username = substr(username, 1, 55) || '-' || substr(id, 1, 8) WHERE EXISTS (
  SELECT 1 FROM ${table} o WHERE o.username = ${table}.username COLLATE NOCASE AND o.id <> ${table}.id
    AND (o.created_at < ${table}.created_at OR (o.created_at = ${table}.created_at AND o.id < ${table}.id))
)`,
    `CREATE UNIQUE INDEX ${table}_username_nocase ON ${table} (username COLLATE NOCASE)`,
  ]),
  // Events that repeat (a source opened, a request refused) are written once
  // per `dedupe` key, which carries the hour: the database refuses the second.
  `ALTER TABLE audit_log ADD COLUMN dedupe TEXT`,
  `CREATE UNIQUE INDEX audit_log_dedupe ON audit_log (dedupe) WHERE dedupe IS NOT NULL`,
  `CREATE INDEX audit_log_target ON audit_log (target_id, id)`,
  `CREATE INDEX audit_log_actor_id ON audit_log (actor_id, id)`,
  // What the installation decided about itself (how long the audit log is kept, for example).
  `CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  // A suspended account keeps everything it has and can do nothing with it.
  `ALTER TABLE admins ADD COLUMN suspended_at INTEGER`,
  `ALTER TABLE readers ADD COLUMN suspended_at INTEGER`,
  `ALTER TABLE api_keys ADD COLUMN name TEXT`,
  `ALTER TABLE api_keys ADD COLUMN expires_at INTEGER`,
  `ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER`,
  // How many times something was tried, per key, since `started_at`: see throttle.ts.
  `CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
)`,
  `CREATE INDEX login_attempts_started_at ON login_attempts (started_at)`,
  // Never holds a row. Inserting a 0 fails, and takes the whole operation with
  // it: that is how a change is called off from inside the operation (see `guard`).
  `CREATE TABLE guards (
  ok INTEGER NOT NULL CONSTRAINT guard_refused CHECK (ok = 1)
)`,
  // Two-step verification, which each administrator turns on for themselves.
  // `mfa_secret` is the key of their authenticator app, encrypted (see
  // security.ts); it is in use once `mfa_enabled_at` is set. `mfa_last_step`
  // is the last code accepted, so that no code is accepted twice.
  `ALTER TABLE admins ADD COLUMN mfa_secret TEXT`,
  `ALTER TABLE admins ADD COLUMN mfa_enabled_at INTEGER`,
  `ALTER TABLE admins ADD COLUMN mfa_last_step INTEGER NOT NULL DEFAULT 0`,
  // Sources are uploaded, no longer read from the repository. The bytes of a
  // file are in the file storage, under sources/<storage>/<path>; its row here
  // is what makes it exist: a file without a row is never served. `storage`
  // is a random name, not the alias, so that a source removed and created
  // again under the same alias never meets the files of the old one.
  // `files` and `bytes` are kept up to date with every upload and removal.
  `ALTER TABLE sources ADD COLUMN storage TEXT`,
  `UPDATE sources SET storage = lower(hex(randomblob(16))) WHERE storage IS NULL`,
  `CREATE UNIQUE INDEX sources_storage ON sources (storage)`,
  `ALTER TABLE sources ADD COLUMN files INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sources ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE source_files (
  alias TEXT NOT NULL REFERENCES sources (alias) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (alias, path)
)`,
  // Stored files of removed sources, waiting for the scheduled job to delete them a few at a time.
  `CREATE TABLE file_purges (
  key TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL
)`,
  `CREATE INDEX file_purges_queued_at ON file_purges (queued_at)`,
  // Readers get two-step verification too, with the same three columns as the
  // administrators. Whether they must use it is a setting (see `READER_TWO_STEP_REQUIRED`).
  `ALTER TABLE readers ADD COLUMN mfa_secret TEXT`,
  `ALTER TABLE readers ADD COLUMN mfa_enabled_at INTEGER`,
  `ALTER TABLE readers ADD COLUMN mfa_last_step INTEGER NOT NULL DEFAULT 0`,
];

/** How long a login session lasts. */
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long the link that lets a reader choose their password works. Short on
 * purpose: until it is used, the link is a password in an address.
 */
export const INVITE_MS = 72 * 60 * 60 * 1000;
/** Wrong root password attempts accepted per hour from one address, and from all addresses together. */
export const ROOT_ATTEMPTS_PER_HOUR = 5;
const ROOT_ATTEMPTS_PER_HOUR_ALL = 100;
/** The root password is a secret someone generated, not one someone remembers: a short one is refused outright. */
export const ROOT_PASSWORD_MIN = 32;
/** Wrong sign-in attempts in fifteen minutes: for one account from one address, from one address, and for one account from anywhere. */
export const LOGIN_ATTEMPTS = { pair: 5, address: 50, account: 20 };
/** Items per page in listings. */
export const PAGE_SIZE = 50;
/** The largest file a source can hold: the limit a file of sites/ already had on Cloudflare. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** The longest path of a file inside its source, in bytes of UTF-8. */
export const MAX_PATH_BYTES = 900;
/** How many files one source can hold. */
export const MAX_SOURCE_FILES = 20_000;
/** The most files one request of the listing answers. */
export const FILE_LIST_MAX = 1000;
/** Stored files deleted by one run of the purge: kept under what a single request may ask of the storage. */
const FILE_PURGE_BATCH = 40;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface Ctx {
  db: Database;
  /** Where the files of the sources are stored. */
  files: Files;
  /** The repository's sites/ folder: the white label and the installation's settings. */
  sites: Sites;
  secrets: Secrets;
  /** The installation's sites/gatefold.json, read before the first request is handled (see main.ts). */
  config: Config;
}

/** The visitor's address, from the source the installation trusts. */
export function ipOf(ctx: Ctx, request: Request): string | null {
  return clientIp(request, ctx.config);
}

/**
 * A change made with a cookie, a password or a link only counts if the browser
 * says it came from this site. A refusal is written down, once an hour for
 * each address it comes from: someone is pointing a browser at this site.
 * `actor` is who the request claims to be, when that is already known.
 */
export async function requireSameOrigin(ctx: Ctx, request: Request, actor?: Actor): Promise<void> {
  if (sameOrigin(request, ctx.config)) return;
  const ip = ipOf(ctx, request);
  await ctx.db.batch([
    recordOnce(actor ?? visitor(ip), "request.refused", `refused:${ip ?? "unknown"}:${hourOf(Date.now())}`, {
      // An access link is a password in an address: the path is written without it.
      path: new URL(request.url).pathname.replace(/\/invite\/.*/, "/invite/…").slice(0, 200),
      origin: (request.headers.get("origin") ?? "").slice(0, 200),
    }),
  ]);
  throw new HttpError(403, "Request refused: it did not come from this site.");
}

export type Statement = [sql: string, ...params: SqlParam[]];
export type Row = Record<string, SqlValue>;
type Input = Record<string, unknown>;

/** An error whose message is meant for whoever made the request. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Stops the handler with a ready response (a redirect, for example). */
export class Reply {
  response: Response;
  constructor(response: Response) {
    this.response = response;
  }
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const ALIAS = /^[a-z0-9-]+$/;

function username(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._@-]{3,64}$/.test(value)) {
    throw new HttpError(400, "The username must have 3 to 64 characters: letters, digits, dot, hyphen, underscore or @.");
  }
  return value;
}

function email(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new HttpError(400, "The email is not valid.");
  }
  return value.trim().toLowerCase();
}

export const PASSWORD_MIN = 10;
/** Said wherever a password is asked for. */
export const PASSWORD_HINT = `At least ${PASSWORD_MIN} characters. Not your name or email, and not a common password.`;

/** Passwords of the minimum length or more that are tried first by anyone guessing. */
const COMMON_PASSWORDS = new Set([
  "1234567890", "0123456789", "12345678910", "123456789a", "1q2w3e4r5t", "qwertyuiop", "qwerty12345", "qwerty123456", "password123", "password1234",
  "passwordpassword", "password12345", "mypassword1", "administrator", "changeme123", "letmein1234", "iloveyou123", "welcome12345", "welcome123", "abcdefghij",
  "abc1234567", "a123456789", "1234512345", "1122334455", "0987654321", "9876543210", "senha12345", "senha123456", "mudar12345",
]);

/**
 * `about` is what is known of the account (its name, its email): a password
 * equal to one of them is the first thing anyone tries.
 */
function password(value: unknown, about: (string | null | undefined)[] = []): string {
  if (typeof value !== "string" || value.length < PASSWORD_MIN || value.length > 256) {
    throw new HttpError(400, `The password must have ${PASSWORD_MIN} to 256 characters.`);
  }
  const lower = value.toLowerCase();
  const known = about.flatMap((item) => (item ? [item.toLowerCase(), item.toLowerCase().split("@")[0]!] : []));
  if (known.includes(lower)) throw new HttpError(400, "The password cannot be the username or the email.");
  if (new Set(lower).size < 4 || COMMON_PASSWORDS.has(lower)) throw new HttpError(400, "This password is too easy to guess. Choose another.");
  return value;
}

/** Accepts the object (API) or the JSON text (form) and returns the text to store. */
export function propsText(value: unknown): string {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value.trim() === "" ? "{}" : value);
    } catch {
      throw new HttpError(400, "The props are not valid JSON.");
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, 'The props must be a JSON object, for example {"theme": "dark"}.');
  }
  const text = JSON.stringify(parsed);
  if (text.length > MAX_PROPS) throw new HttpError(400, `The props exceed the maximum size (${MAX_PROPS} characters).`);
  return text;
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}

function parseObject(text: SqlValue | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(typeof text === "string" ? text : "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseList(text: SqlValue | undefined, fallback: string[]): string[] {
  try {
    const parsed: unknown = JSON.parse(typeof text === "string" ? text : "");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : fallback;
  } catch {
    return fallback;
  }
}

/** A name or an email that is already taken becomes a message; any other failure is not hidden behind one. */
/**
 * A statement that calls the whole operation off when `condition` holds. It
 * goes in the same batch as the change it protects, so the check and the
 * change cannot come apart. `guardRefused` tells that failure from any other.
 */
function guard(condition: string, ...params: SqlParam[]): Statement {
  return [`INSERT INTO guards (ok) SELECT 0 WHERE ${condition}`, ...params];
}

function guardRefused(error: unknown): boolean {
  return error instanceof Error && /guard_refused/.test(error.message);
}

function conflict(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (/UNIQUE constraint failed/i.test(message)) {
    if (/\.email\b/.test(message)) throw new HttpError(409, "A reader with this email already exists.");
    if (/\.username\b/.test(message)) throw new HttpError(409, "A user with this name already exists.");
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  /** Only readers have props. */
  props: Record<string, unknown>;
}

export interface Session {
  role: Role;
  user: User;
  /** Authenticated by API key rather than by cookie. */
  viaKey: boolean;
  /** The session in the database, when there is one (a key has none). */
  sid: string | null;
  /** The same person, as the audit log writes them down. */
  actor: Actor;
  /** Rows of the reads requested together with the session check. */
  rows: Row[][];
  /** A reader who must set up two-step verification before anything else: only `duringSetup` lets them in. */
  twoStepOwed: boolean;
}

/** How SQL reaches the authenticated user's identifier, before the database has answered. */
export interface UserRef {
  sql: string;
  params: SqlParam[];
  /** How they are authenticated, for the audit rows written together with the reads. */
  via: "session" | "key";
}

type Credential = { kind: "session"; claims: Claims } | { kind: "key"; hash: string };

const TABLE: Record<Role, { table: string; column: string; extra: string }> = {
  admin: { table: "admins", column: "admin_id", extra: "" },
  reader: { table: "readers", column: "reader_id", extra: ", u.props" },
};

/** The setting, as SQL reads it: an administrator decided that every reader uses two-step verification. */
const READER_TWO_STEP_KEY = "reader_two_step_required";
const READER_TWO_STEP_REQUIRED = `EXISTS (SELECT 1 FROM settings WHERE key = '${READER_TWO_STEP_KEY}' AND value = '1')`;
/** True for the reader `u` who has to set it up and has not. */
const TWO_STEP_OWED = `(u.mfa_enabled_at IS NULL AND ${READER_TWO_STEP_REQUIRED})`;

/**
 * A reader who has not set up the two-step verification their administrators
 * require. Nothing is done in their name until they do: the pages send them
 * to Your account, and the API answers with this.
 */
export class TwoStepRequired extends HttpError {
  constructor() {
    super(403, "Two-step verification is required for this account and is not set up yet. Sign in with your password and set it up under Your account (/reader/account).");
  }
}

async function credential(ctx: Ctx, request: Request, role: Role, allowKey: boolean, now: number): Promise<Credential | null> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer !== undefined) {
    if (!allowKey || !bearer.startsWith(role === "admin" ? "cn_a_" : "cn_r_")) return null;
    return { kind: "key", hash: await hashApiKey(ctx.secrets.get(SECRET_MASTER), bearer) };
  }
  const token = readCookie(request, cookieName(role));
  if (!token) return null;
  const claims = await verifyToken(ctx.secrets.get(SECRET_SIGNING), token, now);
  return claims && claims.role === role ? { kind: "session", claims } : null;
}

/**
 * Checks who is calling and, in the same database round trip, runs the reads
 * in `reads`. Returns a `null` session when there is no valid session or key;
 * the reads are discarded in that case. `visitorReads` runs in their place
 * when the request carries no credential at all (public sources).
 *
 * A reader who owes the setup of two-step verification is refused with
 * `TwoStepRequired`, by cookie and by key alike, and the reads made in their
 * name find nobody. `duringSetup` is for the few routes where they do it.
 */
export async function identify(
  ctx: Ctx,
  request: Request,
  role: Role,
  options: { allowKey: boolean; reads?: (user: UserRef) => Statement[]; visitorReads?: Statement[]; duringSetup?: boolean },
): Promise<{ session: Session | null; rows: Row[][] }> {
  const now = Date.now();
  const found = await credential(ctx, request, role, options.allowKey, now);
  if (!found) {
    return { session: null, rows: options.visitorReads ? await ctx.db.batch(options.visitorReads) : [] };
  }
  const { table, column, extra } = TABLE[role];
  let principal: Statement;
  let ref: UserRef;
  const closing: Statement[] = [];
  const owed = role === "reader" ? TWO_STEP_OWED : "0";
  const settled = options.duringSetup ? "" : ` AND NOT ${owed}`;
  // A suspended account and an expired key are refused where the user is found, and so are the reads made in their name.
  if (found.kind === "session") {
    const valid = `FROM sessions s JOIN ${table} u ON u.id = s.${column} WHERE s.id = ? AND s.${column} = ? AND s.expires_at > ? AND u.suspended_at IS NULL`;
    const params = [found.claims.sid, found.claims.sub, now];
    principal = [`SELECT u.id, u.username${extra}, ${owed} AS two_step_owed ${valid}`, ...params];
    ref = { sql: `(SELECT u.id ${valid}${settled})`, params, via: "session" };
  } else {
    const valid = `FROM api_keys k JOIN ${table} u ON u.id = k.${column} WHERE k.key_hash = ? AND (k.expires_at IS NULL OR k.expires_at > ?) AND u.suspended_at IS NULL`;
    const params = [found.hash, now];
    principal = [`SELECT u.id, u.username${extra}, ${owed} AS two_step_owed ${valid}`, ...params];
    ref = { sql: `(SELECT u.id ${valid}${settled})`, params, via: "key" };
    // When the key was last used, to the hour: enough to tell a key in use from a forgotten one.
    closing.push(["UPDATE api_keys SET last_used_at = ? WHERE key_hash = ? AND (last_used_at IS NULL OR last_used_at < ?)", now, found.hash, now - HOUR_MS]);
  }
  const reads = options.reads?.(ref) ?? [];
  const [who = [], ...results] = await ctx.db.batch([principal, ...reads, ...closing]);
  const rows = results.slice(0, reads.length);
  const row = who[0];
  if (!row) return { session: null, rows };
  const user: User = { id: String(row.id), username: String(row.username), props: parseObject(row.props) };
  const viaKey = found.kind === "key";
  const actor: Actor = { role, id: user.id, name: user.username, via: viaKey ? "key" : "session", ip: ipOf(ctx, request) };
  if (found.kind === "session" && request.method !== "GET" && request.method !== "HEAD") await requireSameOrigin(ctx, request, actor);
  const twoStepOwed = row.two_step_owed === 1;
  if (twoStepOwed && !options.duringSetup) throw new TwoStepRequired();
  return { session: { role, user, viaKey, sid: found.kind === "session" ? found.claims.sid : null, actor, rows, twoStepOwed }, rows };
}

/** The name the audit log gives to a sign-in attempt for an account that does not exist. */
export const UNKNOWN_NAME = "(unknown)";

export interface LoginResult {
  cookie: string;
  user: { id: string; username: string };
  /** A reader who is signed in and can do one thing only: set up the two-step verification that is required of them. */
  twoStepOwed: boolean;
}

/**
 * Two database round trips. The first counts the attempt and fetches the
 * user; the second, once the password checks out, stores the session and takes
 * the attempt back. Too many attempts are refused before the password is even
 * looked at. A refused sign-in is written to the audit log: with the account's
 * name when there is one, and never with the password.
 */
export async function login(ctx: Ctx, request: Request, role: Role, input: Input): Promise<LoginResult> {
  await requireSameOrigin(ctx, request);
  const name = typeof input.username === "string" ? input.username.slice(0, 256) : "";
  const secret = typeof input.password === "string" ? input.password.slice(0, 256) : "";
  const master = ctx.secrets.get(SECRET_MASTER);
  const ip = ipOf(ctx, request);
  const now = Date.now();
  const account = await hashAttempt(master, `${role}:${name.toLowerCase()}`);
  // With no address to go by, everyone who tries this account is counted together.
  const pair = `login:${account}:${ip ?? "unknown"}`;
  const limits: Limit[] = [
    { key: pair, max: LOGIN_ATTEMPTS.pair },
    ...(ip ? [{ key: `login-from:${ip}`, max: LOGIN_ATTEMPTS.address }] : []),
    { key: `login:${account}`, max: LOGIN_ATTEMPTS.account },
  ];
  const [counted = [], users = []] = await ctx.db.batch([
    countAttempts(limits, now),
    [`SELECT id, username, password_hash, suspended_at, mfa_secret, mfa_enabled_at, mfa_last_step, ${role === "reader" ? READER_TWO_STEP_REQUIRED : "0"} AS mfa_required FROM ${TABLE[role].table} WHERE username = ? COLLATE NOCASE`, name],
  ]);
  const row = users[0];
  // What was typed is only written down when it is the name of an account: people type passwords into the wrong field.
  const actor: Actor = { role, id: row ? String(row.id) : null, name: row ? String(row.username) : UNKNOWN_NAME, via: "password", ip };
  if (overLimit(counted, limits, true)) {
    await ctx.db.batch([recordOnce(actor, "login.blocked", `blocked:${pair}:${hourOf(now)}`)]);
    throw new HttpError(429, "Too many sign-in attempts. Wait fifteen minutes and try again.");
  }
  const valid = await verifyPassword(master, secret, row ? String(row.password_hash) : null);
  if (!row || !valid) {
    await ctx.db.batch([record(actor, "login.failed", null)]);
    throw new HttpError(401, "Invalid username or password.");
  }
  // Said only to whoever has the password: nobody else learns that the account exists, or that it is suspended.
  if (row.suspended_at !== null) {
    await ctx.db.batch([record(actor, "login.failed", null, { reason: "suspended" }), uncountAttempts(limits)]);
    throw new HttpError(403, "This account is suspended. Ask an administrator.");
  }
  const sid = randomId();
  const id = String(row.id);
  // Two-step verification, for the accounts that have it on: the password was right, now the code.
  let step: number | null = null;
  if (typeof row.mfa_enabled_at === "number") {
    const code = typeof input.code === "string" ? input.code.replace(/\s+/g, "").slice(0, 16) : "";
    // No code at all is not a guess: the attempt is taken back, and nothing is written down.
    if (code === "") {
      await ctx.db.batch([uncountAttempts(limits)]);
      throw new HttpError(401, MFA_CODE_NEEDED);
    }
    const secret = await openMfaSecret(master, String(row.mfa_secret ?? ""), id);
    step = secret === null ? null : await matchMfaCode(secret, code, now);
    // A code that was already used is refused like a wrong one: whoever saw it typed cannot use it again.
    if (step === null || step <= Number(row.mfa_last_step)) await wrongMfaCode(ctx, actor);
  }
  const token = await signToken(ctx.secrets.get(SECRET_SIGNING), { sid, sub: id, role, exp: Math.floor((now + SESSION_MS) / 1000) });
  try {
    await ctx.db.batch([
      // Of two requests with the same code, only the first finds it unused.
      ...(step === null ? [] : [
        guard(`NOT EXISTS (SELECT 1 FROM ${TABLE[role].table} WHERE id = ? AND mfa_last_step < ?)`, id, step),
        [`UPDATE ${TABLE[role].table} SET mfa_last_step = ? WHERE id = ?`, step, id] as Statement,
      ]),
      [`INSERT INTO sessions (id, ${TABLE[role].column}, created_at, expires_at) VALUES (?, ?, ?, ?)`, sid, id, now, now + SESSION_MS],
      record(actor, "login", null, step === null ? {} : { two_step: true }),
      uncountAttempts(limits),
      forgetAttempts(pair),
    ]);
  } catch (error) {
    if (guardRefused(error)) await wrongMfaCode(ctx, actor);
    throw error;
  }
  return {
    cookie: sessionCookie(role, token, SESSION_MS / 1000), user: { id, username: String(row.username) },
    twoStepOwed: row.mfa_enabled_at === null && row.mfa_required === 1,
  };
}

const MFA_CODE_NEEDED = "This account uses two-step verification. Sign in again with your password and the 6-digit code from your authenticator app.";

/** The attempt stays counted: six digits are easy to guess for whoever is allowed to keep trying. */
async function wrongMfaCode(ctx: Ctx, actor: Actor): Promise<never> {
  await ctx.db.batch([record(actor, "login.failed", null, { reason: "wrong code" })]);
  throw new HttpError(401, "The verification code is not right, or was already used. Wait for the next code in your authenticator app and try again.");
}

/** Deletes the cookie's session, if there is one, and returns the cookie that clears the browser. */
export async function logout(ctx: Ctx, request: Request, role: Role): Promise<string> {
  await requireSameOrigin(ctx, request);
  const token = readCookie(request, cookieName(role));
  const claims = token ? await verifyToken(ctx.secrets.get(SECRET_SIGNING), token, Date.now()) : null;
  if (claims && claims.role === role) {
    const { table, column } = TABLE[role];
    await ctx.db.batch([
      // The row carries the name read from the session being closed; a session that is already gone leaves no row.
      recordAs({ role, via: "session", ip: ipOf(ctx, request) }, "logout", {
        from: `sessions s JOIN ${table} u ON u.id = s.${column} WHERE s.id = ?`, params: [claims.sid], id: "u.id", name: "u.username",
      }),
      ["DELETE FROM sessions WHERE id = ?", claims.sid],
    ]);
  }
  return clearCookie(role);
}

/**
 * Root password. Wrong attempts are counted per hour for each address, so
 * that a stranger who guesses locks only themselves out; a much higher count
 * of all addresses together stops a guess spread over many. Where the app
 * cannot tell addresses apart (see `client_ip` in config.ts), everyone is one
 * address, and five wrong attempts lock root for everyone for the hour.
 */
export async function requireRoot(ctx: Ctx, request: Request): Promise<void> {
  const ip = ipOf(ctx, request);
  const actor = rootActor(ip);
  if (request.method !== "GET") await requireSameOrigin(ctx, request, actor);
  const secret = ctx.secrets.get(SECRET_ROOT);
  if (secret.length < ROOT_PASSWORD_MIN) {
    throw new HttpError(503, `Root access is off: the ${SECRET_ROOT} secret must have at least ${ROOT_PASSWORD_MIN} characters. Set a longer one where the app runs.`);
  }
  const now = Date.now();
  const limits: Limit[] = [{ key: `root:${ip ?? "unknown"}`, max: ROOT_ATTEMPTS_PER_HOUR }, { key: "root:*", max: ROOT_ATTEMPTS_PER_HOUR_ALL }];
  if (overLimit(await ctx.db.query(...readAttempts(limits, now, HOUR_MS)), limits, false)) {
    await ctx.db.batch([recordOnce(actor, "root.blocked", `root-blocked:${ip ?? "unknown"}:${hourOf(now)}`)]);
    throw new HttpError(429, "Too many wrong root password attempts. Try again in an hour.");
  }
  const given = request.headers.get("x-root-password") ?? "";
  if (given !== "" && (await safeEqual(given, secret))) return;
  await ctx.db.batch([countAttempts(limits, now, HOUR_MS), record(actor, "root.denied", null)]);
  throw new HttpError(401, "Wrong root password.");
}

/** Scheduled job, every hour: expired sessions, expired access links and old counts of attempts. */
export async function cleanup(ctx: Ctx, time: Date): Promise<void> {
  await ctx.db.batch([
    ["DELETE FROM sessions WHERE expires_at < ?", time.getTime()],
    ["DELETE FROM invites WHERE expires_at < ?", time.getTime()],
    cleanupAttempts(time.getTime()),
    setSetting("cron_last_run", String(time.getTime()), time.getTime()),
  ]);
}

// ---------------------------------------------------------------------------
// Policy: what only root decides
// ---------------------------------------------------------------------------

/** How long an audit entry is kept, when root never said otherwise. */
export const DEFAULT_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 3650;
/** Old entries removed by one run of the scheduled job. A backlog is cleared over a few days. */
const PURGE_BATCH = 20_000;

function setSetting(key: string, value: string, now: number): Statement {
  return ["INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, value, now];
}

/** The retention period as SQL reads it, in days. */
const RETENTION_SQL = `COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'audit_retention_days'), ${DEFAULT_RETENTION_DAYS})`;

export const POLICY: Statement = [`SELECT ${RETENTION_SQL} AS audit_retention_days`];

export interface Policy {
  /** Audit entries older than this many days are removed by the scheduled job. */
  audit_retention_days: number;
}

export function policy(rows: Row[] | undefined): Policy {
  return { audit_retention_days: Number(rows?.[0]?.audit_retention_days ?? DEFAULT_RETENTION_DAYS) };
}

/**
 * Only root sets the policy: an administrator who could shorten the retention
 * could make their own trail disappear sooner.
 */
export async function setPolicy(ctx: Ctx, actor: Actor, input: Input): Promise<Policy> {
  const days = input.audit_retention_days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new HttpError(400, `"audit_retention_days" must be a whole number from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}.`);
  }
  await ctx.db.batch([
    record(actor, "settings.updated", null, { audit_retention_days: days }),
    setSetting("audit_retention_days", String(days), Date.now()),
  ]);
  return { audit_retention_days: days };
}

/**
 * Scheduled job, once a day: audit entries older than the retention period
 * are removed, and a row says how many went and from which date back. That
 * row is the only trace of them, so it is written first, in the same operation.
 */
export async function purgeAudit(ctx: Ctx, time: Date): Promise<void> {
  const now = time.getTime();
  const cutoff = `(? - ${RETENTION_SQL} * ${DAY_MS})`;
  const old = `SELECT id FROM audit_log WHERE at < ${cutoff} ORDER BY id LIMIT ${PURGE_BATCH}`;
  await ctx.db.batch([
    [
      "INSERT INTO audit_log (at, actor_role, actor_name, via, action, details) " +
        `SELECT ?, 'system', 'system', 'system', 'audit.purged', json_object('rows', n, 'older_than', ${cutoff}, 'retention_days', ${RETENTION_SQL}) FROM (SELECT COUNT(*) AS n FROM (${old})) WHERE n > 0`,
      now, now, now,
    ],
    [`DELETE FROM audit_log WHERE id IN (${old})`, now],
  ]);
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export interface Page<Item> {
  items: Item[];
  page: number;
  hasNext: boolean;
}

/** "2026-01-31" (the whole day, in UTC) or milliseconds since 1970. */
function dateFilter(value: string | null, endOfDay: boolean): number | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(start)) throw new HttpError(400, `Invalid date: ${value}.`);
    return endOfDay ? start + 24 * HOUR_MS - 1 : start;
  }
  if (/^\d{1,15}$/.test(value)) return Number(value);
  throw new HttpError(400, `Invalid date: ${value}. Use the format YYYY-MM-DD.`);
}

function pageNumber(filters: URLSearchParams): number {
  const page = Number(filters.get("page") ?? "1");
  return Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1;
}

/** Common filters, all on indexed columns: name prefix and creation range. */
function commonFilters(filters: URLSearchParams, nameColumn: string, dateColumn: string | null): { where: string[]; params: SqlParam[] } {
  const where: string[] = [];
  const params: SqlParam[] = [];
  const q = filters.get("q");
  if (q) {
    where.push(`${nameColumn} >= ? AND ${nameColumn} < ?`);
    params.push(q, `${q}￿`);
  }
  if (dateColumn) {
    const from = dateFilter(filters.get("created_from"), false);
    const to = dateFilter(filters.get("created_to"), true);
    if (from !== null) (where.push(`${dateColumn} >= ?`), params.push(from));
    if (to !== null) (where.push(`${dateColumn} <= ?`), params.push(to));
  }
  return { where, params };
}

function paged<Item>(rows: Row[], page: number, map: (row: Row) => Item): Page<Item> {
  return { items: rows.slice(0, PAGE_SIZE).map(map), page, hasNext: rows.length > PAGE_SIZE };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** A source as the listing shows it. */
export interface SourceSummary {
  alias: string;
  public: boolean;
  created_at: number;
  /** Readers with permission. */
  readers: number;
  /** How many files it holds, and how many bytes they add up to. */
  files: number;
  bytes: number;
}

export interface Source extends SourceSummary {
  /** Read from the source's source.json; see `origin`. */
  props: Record<string, unknown>;
  render: string[];
  /**
   * Where `props` and `render` come from: "file" is the source.json uploaded
   * with the source, "default" is a source without that file, and "legacy" is
   * a source without it that still has values stored by an older version of
   * the console.
   */
  origin: "file" | "default" | "legacy";
  /** What is wrong with the source.json, if anything. */
  problems: string[];
}

/** Where a file of a source is kept in the file storage. `storage` is the source's own random name there. */
export function fileKey(storage: string, path: string): string {
  return `${SOURCES_FOLDER}/${storage}/${path}`;
}

/**
 * The rendering settings in force for a source row: its source.json when it
 * has one (`hasConfig`, known from the database, so that no file is looked for
 * in vain), otherwise what the row still stores from before the file existed.
 */
export async function sourceSettings(ctx: Ctx, row: Row, hasConfig: boolean): Promise<Pick<Source, "props" | "render" | "origin" | "problems">> {
  const config = hasConfig ? await loadSourceConfig(ctx.files, fileKey(String(row.storage), SOURCE_CONFIG)) : null;
  if (config) return { ...config, origin: "file" };
  const render = parseList(row.render, [...DEFAULT_RENDER]);
  const props = parseObject(row.props);
  const untouched = Object.keys(props).length === 0 && JSON.stringify(render) === JSON.stringify(DEFAULT_RENDER);
  return { props, render, origin: untouched ? "default" : "legacy", problems: [] };
}

function toSummary(row: Row): SourceSummary {
  return {
    alias: String(row.alias),
    public: row.public === 1,
    created_at: Number(row.created_at),
    readers: Number(row.readers ?? 0),
    files: Number(row.files ?? 0),
    bytes: Number(row.bytes ?? 0),
  };
}

const SOURCE_COLUMNS =
  "s.alias, s.public, s.props, s.render, s.created_at, s.storage, s.files, s.bytes, " +
  "(SELECT COUNT(*) FROM permissions p WHERE p.source_alias = s.alias) AS readers, " +
  `EXISTS (SELECT 1 FROM source_files f WHERE f.alias = s.alias AND f.path = '${SOURCE_CONFIG}') AS has_config`;

/** Filters: `q` (alias prefix), `created_from`, `created_to`, `min_readers`, `page`. */
export function listSourcesQuery(filters: URLSearchParams): Statement {
  const { where, params } = commonFilters(filters, "s.alias", "s.created_at");
  const minimum = Number(filters.get("min_readers") ?? "0");
  const page = pageNumber(filters);
  return [
    `SELECT * FROM (SELECT ${SOURCE_COLUMNS} FROM sources s${where.length ? ` WHERE ${where.join(" AND ")}` : ""}) ` +
      "WHERE readers >= ? ORDER BY created_at DESC, alias LIMIT ? OFFSET ?",
    ...params, Number.isInteger(minimum) && minimum > 0 ? minimum : 0, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE,
  ];
}

/** The listing says how much each source holds, not how it is rendered: that would be a file read for each row. */
export function sourcesPage(rows: Row[], filters: URLSearchParams): Page<SourceSummary> {
  return paged(rows, pageNumber(filters), toSummary);
}

export const SOURCE_ALIASES: Statement = ["SELECT alias, public FROM sources ORDER BY alias"];

export function sourceQuery(alias: string): Statement {
  return [`SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.alias = ?`, alias];
}

export async function oneSource(ctx: Ctx, rows: Row[]): Promise<Source> {
  const row = rows[0];
  if (!row) throw new HttpError(404, "Source not found.");
  return { ...toSummary(row), ...(await sourceSettings(ctx, row, row.has_config === 1)) };
}

function sourceFound(alias: string): Found {
  return { from: "sources s WHERE s.alias = ?", params: [alias], id: "s.alias", name: "s.alias" };
}

/** The longest alias a new source can take. */
export const ALIAS_MAX = 64;
export const ALIAS_HINT = `1 to ${ALIAS_MAX} characters: lowercase letters, digits and hyphens. It is the source's address: /reader/view/<alias>/.`;

function randomHex(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A new source is empty and, unless `public` says otherwise, private: its files are uploaded next. */
export async function createSource(ctx: Ctx, actor: Actor, input: Input): Promise<SourceSummary> {
  const alias = input.alias;
  if (typeof alias !== "string" || !ALIAS.test(alias) || alias.length > ALIAS_MAX) {
    throw new HttpError(400, `The alias must have 1 to ${ALIAS_MAX} characters: lowercase letters, digits and hyphens.`);
  }
  const isPublic = input.public !== undefined && flag(input.public);
  const now = Date.now();
  try {
    await ctx.db.batch([
      ["INSERT INTO sources (alias, public, created_at, storage) VALUES (?, ?, ?, ?)", alias, isPublic, now, randomHex()],
      record(actor, "source.created", { type: "source", id: alias, name: alias }, { public: isPublic }),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: sources\.alias/i.test(error.message)) throw new HttpError(409, "A source with this alias already exists.");
    throw error;
  }
  return { alias, public: isPublic, created_at: now, readers: 0, files: 0, bytes: 0 };
}

/** Only the visibility is changed here: `render` and `props` live in the source's source.json. */
export async function updateSource(ctx: Ctx, actor: Actor, alias: string, input: Input): Promise<void> {
  if (input.props !== undefined || input.render !== undefined) {
    throw new HttpError(400, `The props and the rendered extensions are set in the source's ${SOURCE_CONFIG}: upload that file to change them. Only "public" can be changed here.`);
  }
  if (input.public === undefined) throw new HttpError(400, "Nothing to change.");
  const [, changed = []] = await ctx.db.batch([
    recordFound(actor, "source.updated", "source", sourceFound(alias), { public: flag(input.public) }),
    ["UPDATE sources SET public = ? WHERE alias = ? RETURNING alias", flag(input.public), alias],
  ]);
  if (changed.length === 0) throw new HttpError(404, "Source not found.");
}

/**
 * The source goes with its visibility, its permissions and its files. From
 * this moment nothing of it is served: the rows are gone in one operation.
 * The stored files are deleted a few at a time, here and then by the
 * scheduled job, because one request may only ask so much of the storage.
 * Answers how many stored files are still waiting.
 */
export async function deleteSource(ctx: Ctx, actor: Actor, alias: string): Promise<{ files_pending: number }> {
  const results = await ctx.db.batch([
    recordFound(actor, "source.removed", "source", sourceFound(alias)),
    [
      `INSERT OR IGNORE INTO file_purges (key, queued_at) SELECT '${SOURCES_FOLDER}/' || s.storage || '/' || f.path, ? FROM source_files f JOIN sources s ON s.alias = f.alias WHERE f.alias = ?`,
      Date.now(), alias,
    ],
    ["DELETE FROM source_files WHERE alias = ?", alias],
    ["DELETE FROM permissions WHERE source_alias = ?", alias],
    ["DELETE FROM sources WHERE alias = ? RETURNING alias", alias],
  ]);
  if ((results[4] ?? []).length === 0) throw new HttpError(404, "Source not found.");
  return { files_pending: await purgeFiles(ctx) };
}

/**
 * Scheduled job, every minute, and the last step of removing a source: deletes
 * some of the stored files of removed sources. Answers how many are left.
 */
export async function purgeFiles(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query(`SELECT key FROM file_purges ORDER BY queued_at, key LIMIT ${FILE_PURGE_BATCH}`);
  if (rows.length === 0) return 0;
  const keys = rows.map((row) => String(row.key));
  await Promise.all(keys.map((key) => ctx.files.delete(key)));
  const results = await ctx.db.batch([
    ["DELETE FROM file_purges WHERE key IN (SELECT value FROM json_each(?))", JSON.stringify(keys)],
    ["SELECT COUNT(*) AS n FROM file_purges"],
  ]);
  return Number(results[1]?.[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// The files of a source
// ---------------------------------------------------------------------------

export interface SourceFile {
  /** Where the file is inside its source: "index.html", "img/logo.svg". */
  path: string;
  size: number;
  content_type: string;
  updated_at: number;
}

/**
 * The path of a file inside its source, as it arrives in an address. Refused:
 * nothing at all, a `\`, an empty segment, a segment that starts with a dot
 * (hidden files, and the way out of the folder), control characters and a
 * path longer than the storage takes.
 */
export function filePath(raw: string): string {
  if (raw === "") throw new HttpError(400, "The address must name a file: .../files/<path>.");
  // eslint-disable-next-line no-control-regex
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw) || raw.split("/").some((segment) => segment === "" || segment.startsWith("."))) {
    throw new HttpError(400, "File path refused: no backslash, no empty part, and no part that starts with a dot.");
  }
  if (new TextEncoder().encode(raw).length > MAX_PATH_BYTES) throw new HttpError(400, `The file path is too long: the maximum is ${MAX_PATH_BYTES} bytes.`);
  return raw;
}

function toFile(row: Row): SourceFile {
  return { path: String(row.path), size: Number(row.size), content_type: String(row.content_type), updated_at: Number(row.updated_at) };
}

function fileLimit(filters: URLSearchParams, fallback: number): number {
  const limit = Number(filters.get("limit") ?? "");
  return Number.isInteger(limit) && limit >= 1 && limit <= FILE_LIST_MAX ? limit : fallback;
}

/**
 * The files of a source, in path order. Filters: `q` (path prefix), `after`
 * (the `next_after` of the previous answer) and `limit` (up to 1000).
 */
export function listFilesQuery(alias: string, filters: URLSearchParams, fallback = FILE_LIST_MAX): Statement {
  const where = ["alias = ?"];
  const params: SqlParam[] = [alias];
  const q = filters.get("q");
  if (q) (where.push("path >= ? AND path < ?"), params.push(q, `${q}￿`));
  const after = filters.get("after");
  if (after) (where.push("path > ?"), params.push(after));
  return [`SELECT path, size, content_type, updated_at FROM source_files WHERE ${where.join(" AND ")} ORDER BY path LIMIT ?`, ...params, fileLimit(filters, fallback) + 1];
}

export function filesPage(rows: Row[], filters: URLSearchParams, fallback = FILE_LIST_MAX): { items: SourceFile[]; next_after: string | null } {
  const limit = fileLimit(filters, fallback);
  const items = rows.slice(0, limit).map(toFile);
  return { items, next_after: rows.length > limit ? (items.at(-1)?.path ?? null) : null };
}

/**
 * What is known about one path of a source before it is touched: the source's
 * place in the storage and how many files it holds, whether the file exists,
 * and whether the path collides (`clash`) with what is there: a file where
 * this path needs a folder, or a folder where this path is a file.
 */
export function fileTargetQuery(alias: string, path: string): Statement {
  const segments = path.split("/");
  const parents = segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
  return [
    "SELECT s.storage, s.files, EXISTS (SELECT 1 FROM source_files f WHERE f.alias = s.alias AND f.path = ?) AS existing, " +
      "EXISTS (SELECT 1 FROM source_files f WHERE f.alias = s.alias AND (f.path IN (SELECT value FROM json_each(?)) OR (f.path >= ? AND f.path < ?))) AS clash " +
      "FROM sources s WHERE s.alias = ?",
    path, JSON.stringify(parents), `${path}/`, `${path}0`, alias,
  ];
}

function fileTally(actor: Actor, action: "source.files.uploaded" | "source.files.removed", alias: string, now: number): Statement {
  return recordTally(actor, action, `${action}:${actor.id ?? ""}:${actor.via}:${alias}:${hourOf(now)}`, { type: "source", id: alias, name: alias });
}

/**
 * Adds a file to a source, or replaces the one at the same path. `target` is
 * the row of `fileTargetQuery`. The bytes are stored first and the row is
 * written after: if the second step fails the file is not served (or, for a
 * replacement, is served with the new content), and sending it again puts
 * everything right. The type is told from the name, whatever the request said.
 */
export async function putFile(ctx: Ctx, actor: Actor, alias: string, target: Row | undefined, path: string, bytes: ArrayBuffer): Promise<{ created: boolean; file: SourceFile }> {
  if (!target) throw new HttpError(404, "Source not found.");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(413, `The file is too large: the maximum is ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  if (target.clash === 1) throw new HttpError(409, "A file and a folder cannot share a name in a source. Remove what is there first.");
  const full = `This source already holds ${MAX_SOURCE_FILES} files, the most a source can hold.`;
  if (target.existing !== 1 && Number(target.files) >= MAX_SOURCE_FILES) throw new HttpError(409, full);
  const storage = String(target.storage);
  const file: SourceFile = { path, size: bytes.byteLength, content_type: contentTypeOf(path), updated_at: Date.now() };
  await ctx.files.put(fileKey(storage, path), bytes, file.content_type);
  const there = "EXISTS (SELECT 1 FROM source_files WHERE alias = ? AND path = ?)";
  let results: Row[][];
  try {
    results = await ctx.db.batch([
      // The source was removed (or removed and created again) while the bytes were on their way.
      guard("NOT EXISTS (SELECT 1 FROM sources WHERE alias = ? AND storage = ?)", alias, storage),
      [`UPDATE sources SET files = files - 1, bytes = bytes - (SELECT size FROM source_files WHERE alias = ? AND path = ?) WHERE alias = ? AND ${there} RETURNING alias`, alias, path, alias, alias, path],
      guard("(SELECT files FROM sources WHERE alias = ?) >= ?", alias, MAX_SOURCE_FILES),
      [
        "INSERT INTO source_files (alias, path, size, content_type, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (alias, path) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, updated_at = excluded.updated_at",
        alias, path, file.size, file.content_type, file.updated_at,
      ],
      ["UPDATE sources SET files = files + 1, bytes = bytes + ? WHERE alias = ?", file.size, alias],
      fileTally(actor, "source.files.uploaded", alias, file.updated_at),
    ]);
  } catch (error) {
    // The bytes just stored are left where they are: they have no row, so they are never served, and
    // deleting them here could delete the file of a request that arrived in between.
    if (guardRefused(error)) throw new HttpError(409, `The source was removed while the file was being sent, or it already holds ${MAX_SOURCE_FILES} files.`);
    throw error;
  }
  return { created: (results[1] ?? []).length === 0, file };
}

/** Removes one file. `target` is the row of `fileTargetQuery`. */
export async function deleteFile(ctx: Ctx, actor: Actor, alias: string, target: Row | undefined, path: string): Promise<void> {
  if (!target) throw new HttpError(404, "Source not found.");
  if (target.existing !== 1) throw new HttpError(404, "File not found.");
  // The bytes go first: if the next step fails, the file answers "not found" and removing it again finishes the work.
  await ctx.files.delete(fileKey(String(target.storage), path));
  const there = "EXISTS (SELECT 1 FROM source_files WHERE alias = ? AND path = ?)";
  await ctx.db.batch([
    [`UPDATE sources SET files = files - 1, bytes = bytes - (SELECT size FROM source_files WHERE alias = ? AND path = ?) WHERE alias = ? AND ${there}`, alias, path, alias, alias, path],
    ["DELETE FROM source_files WHERE alias = ? AND path = ?", alias, path],
    fileTally(actor, "source.files.removed", alias, Date.now()),
  ]);
}

/** One file as it was uploaded, for the administrator: no template, no reader. `target` is the row of `fileTargetQuery`. */
export async function readFile(ctx: Ctx, target: Row | undefined, path: string): Promise<Response> {
  if (!target) throw new HttpError(404, "Source not found.");
  const file = target.existing === 1 ? await ctx.files.get(fileKey(String(target.storage), path)) : null;
  if (!file) throw new HttpError(404, "File not found.");
  return file;
}

// ---------------------------------------------------------------------------
// Users (administrators and readers)
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  username: string;
  created_at: number;
  /** Readers only. `null` for a reader created before emails existed. */
  email?: string | null;
  /** Readers only: no password chosen yet, so nobody can sign in as them. */
  pending?: boolean;
  /** Readers: private sources granted. */
  sources?: number;
  /** A suspended account keeps everything it has and cannot sign in or use its keys. */
  suspended: boolean;
  /** Signing in also asks for a code from their authenticator app. */
  two_step?: boolean;
}

function toAccount(row: Row): Account {
  return {
    id: String(row.id),
    username: String(row.username),
    created_at: Number(row.created_at),
    suspended: row.suspended_at !== null && row.suspended_at !== undefined,
    ...(row.pending === undefined ? {} : { email: typeof row.email === "string" ? row.email : null, pending: row.pending === 1 }),
    ...(row.sources === undefined ? {} : { sources: Number(row.sources) }),
    ...(row.mfa_enabled_at === undefined ? {} : { two_step: row.mfa_enabled_at !== null }),
  };
}

/** What a reader has and an administrator has not. */
const READER_COLUMNS = ", u.email, (u.password_hash = '') AS pending, u.mfa_enabled_at";

function userFound(role: Role, id: string): Found {
  return { from: `${TABLE[role].table} u WHERE u.id = ?`, params: [id], id: "u.id", name: "u.username" };
}

/** Filters: `q` (username prefix), `created_from`, `created_to`, `page` and, for readers, `source`. */
export function listAccountsQuery(role: Role, filters: URLSearchParams): Statement {
  // Administrators have no index on creation date: only the name filter.
  const { where, params } = commonFilters(filters, "u.username", role === "reader" ? "u.created_at" : null);
  const source = role === "reader" ? filters.get("source") : null;
  if (source) {
    where.push("u.id IN (SELECT reader_id FROM permissions WHERE source_alias = ?)");
    params.push(source);
  }
  const extra = role === "reader" ? `${READER_COLUMNS}, (SELECT COUNT(*) FROM permissions p WHERE p.reader_id = u.id) AS sources` : ", u.mfa_enabled_at";
  const order = role === "reader" ? "u.created_at DESC, u.id" : "u.username";
  return [
    `SELECT u.id, u.username, u.created_at, u.suspended_at${extra} FROM ${TABLE[role].table} u${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params, PAGE_SIZE + 1, (pageNumber(filters) - 1) * PAGE_SIZE,
  ];
}

export function accountsPage(rows: Row[], filters: URLSearchParams): Page<Account> {
  return paged(rows, pageNumber(filters), toAccount);
}

/**
 * An administrator is created with a password. A reader is created with an
 * email and no password: the answer carries the link through which they
 * choose it (`invite`), which is the only time that link appears.
 */
export async function createAccount(ctx: Ctx, actor: Actor, role: Role, input: Input): Promise<Account & { invite?: Invite }> {
  const name = username(input.username);
  const account: Account = { id: randomId(), username: name, created_at: Date.now(), suspended: false };
  const statements: Statement[] = [];
  let invite: IssuedInvite | undefined;
  if (role === "reader") {
    if (input.password !== undefined && input.password !== "") {
      throw new HttpError(400, "A reader's password is not set here: the reader chooses it through the link returned when the account is created.");
    }
    account.email = email(input.email);
    account.pending = true;
    invite = await issueInvite(ctx, actor, account.id, account.created_at);
    statements.push(
      ["INSERT INTO readers (id, username, email, password_hash, created_at) VALUES (?, ?, ?, '', ?)", account.id, name, account.email, account.created_at],
      record(actor, "reader.created", { type: "reader", id: account.id, name }, { email: account.email }),
      ...invite.statements,
    );
  } else {
    const hash = await hashPassword(ctx.secrets.get(SECRET_MASTER), password(input.password, [name]));
    statements.push(
      ["INSERT INTO admins (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)", account.id, name, hash, account.created_at],
      record(actor, "admin.created", { type: "admin", id: account.id, name }),
    );
  }
  try {
    await ctx.db.batch(statements);
  } catch (error) {
    conflict(error);
  }
  return invite ? { ...account, invite: { token: invite.token, expires_at: invite.expires_at } } : account;
}

/** Where each read of `accountQueries` lands in the results. The last three are only there for a reader. */
export const ACCOUNT_ROWS = { account: 0, keys: 1, allowed: 2, sources: 3, invite: 4 } as const;

export function accountQueries(role: Role, id: string): Statement[] {
  const { table, column } = TABLE[role];
  const queries: Statement[] = [
    [`SELECT u.id, u.username, u.created_at, u.suspended_at${role === "reader" ? `${READER_COLUMNS}, u.props` : ", u.mfa_enabled_at"} FROM ${table} u WHERE u.id = ?`, id],
    [`SELECT ${KEY_COLUMNS} FROM api_keys WHERE ${column} = ? ORDER BY created_at DESC`, id],
  ];
  if (role === "reader") {
    queries.push(
      ["SELECT source_alias FROM permissions WHERE reader_id = ? ORDER BY source_alias", id],
      SOURCE_ALIASES,
      ["SELECT created_at, expires_at FROM invites WHERE reader_id = ? AND expires_at > ?", id, Date.now()],
    );
  }
  return queries;
}

export interface AccountDetail extends Account {
  api_keys: ApiKey[];
  /** Readers: granted aliases. */
  allowed?: string[];
  /** Readers: the access link that is waiting to be used, if there is one. The link itself is never stored. */
  invite?: { created_at: number; expires_at: number } | null;
  /** Readers: their own props, which they and an administrator can change. */
  props?: Record<string, unknown>;
}

export function oneAccount(rows: Row[][]): AccountDetail {
  const row = rows[ACCOUNT_ROWS.account]?.[0];
  if (!row) throw new HttpError(404, "User not found.");
  const allowed = rows[ACCOUNT_ROWS.allowed];
  const invites = rows[ACCOUNT_ROWS.invite];
  const invite = invites?.[0];
  return {
    ...toAccount(row),
    api_keys: (rows[ACCOUNT_ROWS.keys] ?? []).map(toApiKey),
    ...(allowed ? { allowed: allowed.map((permission) => String(permission.source_alias)) } : {}),
    ...(invites ? { invite: invite ? { created_at: Number(invite.created_at), expires_at: Number(invite.expires_at) } : null } : {}),
    ...(row.props === undefined ? {} : { props: parseObject(row.props) }),
  };
}

/**
 * Changes the name and, for administrators, the password; for readers, the
 * email and the granted sources (`sources`: the complete list of aliases).
 * Changing the password deletes the sessions. A reader's password is never
 * set here: see `createInvite`.
 *
 * Two database round trips: the account as it is, then the change. The audit
 * log gets only what is different from before; saving a form without touching
 * it changes nothing and writes nothing.
 */
export async function updateAccount(ctx: Ctx, actor: Actor, role: Role, id: string, input: Input): Promise<void> {
  const { table, column } = TABLE[role];
  const wanted: { username?: string; email?: string; sources?: string[] } = {};
  if (input.username !== undefined) wanted.username = username(input.username);
  if (input.password !== undefined && input.password !== "" && role === "reader") {
    throw new HttpError(400, "A reader's password is not set here: generate an access link, and the reader chooses the password through it.");
  }
  const newPassword = input.password !== undefined && input.password !== "" ? input.password : null;
  // An administrator who could set another's password could sign in as them, and the log would name the wrong person.
  if (newPassword !== null && actor.role !== "root" && actor.id !== id) {
    throw new HttpError(403, "Only the administrator themselves, or whoever holds the root password, sets this password.");
  }
  if (role === "reader" && input.email !== undefined && input.email !== "") wanted.email = email(input.email);
  if (role === "reader" && input.sources !== undefined) {
    const aliases = Array.isArray(input.sources) ? input.sources : [input.sources];
    if (aliases.length > 1000 || aliases.some((alias) => typeof alias !== "string")) throw new HttpError(400, "Invalid list of sources.");
    wanted.sources = [...new Set(aliases as string[])];
  }
  if (wanted.username === undefined && newPassword === null && wanted.email === undefined && wanted.sources === undefined) {
    throw new HttpError(400, "Nothing to change.");
  }

  const [accounts = [], granted = [], existing = []] = await ctx.db.batch([
    [`SELECT username${role === "reader" ? ", email" : ""} FROM ${table} WHERE id = ?`, id],
    role === "reader" ? ["SELECT source_alias AS alias FROM permissions WHERE reader_id = ?", id] : ["SELECT 1 WHERE 0"],
    // Aliases that are not sources are left out, as they always were.
    wanted.sources ? ["SELECT alias FROM sources WHERE alias IN (SELECT value FROM json_each(?))", JSON.stringify(wanted.sources)] : ["SELECT 1 WHERE 0"],
  ]);
  const current = accounts[0];
  if (!current) throw new HttpError(404, "User not found.");

  const statements: Statement[] = [];
  const changed: Record<string, unknown> = {};
  if (wanted.username !== undefined && wanted.username !== current.username) {
    changed.username = wanted.username;
    statements.push([`UPDATE ${table} SET username = ? WHERE id = ?`, wanted.username, id]);
  }
  if (newPassword !== null) {
    changed.password = "changed";
    statements.push(
      [`UPDATE ${table} SET password_hash = ? WHERE id = ?`, await hashPassword(ctx.secrets.get(SECRET_MASTER), password(newPassword, [wanted.username ?? String(current.username)])), id],
      [`DELETE FROM sessions WHERE ${column} = ?`, id],
    );
  }
  if (wanted.email !== undefined && wanted.email !== current.email) {
    changed.email = wanted.email;
    statements.push(["UPDATE readers SET email = ? WHERE id = ?", wanted.email, id]);
  }
  if (wanted.sources) {
    const before = new Set(granted.map((row) => String(row.alias)));
    const after = new Set(existing.map((row) => String(row.alias)));
    const added = [...after].filter((alias) => !before.has(alias)).sort();
    const removed = [...before].filter((alias) => !after.has(alias)).sort();
    if (added.length > 0) {
      changed.sources_added = added;
      // The permission is only inserted if both the reader and the source still exist.
      statements.push([
        "INSERT OR IGNORE INTO permissions (reader_id, source_alias, created_at) SELECT r.id, s.alias, ? FROM readers r, sources s WHERE r.id = ? AND s.alias IN (SELECT value FROM json_each(?))",
        Date.now(), id, JSON.stringify(added),
      ]);
    }
    if (removed.length > 0) {
      changed.sources_removed = removed;
      statements.push(["DELETE FROM permissions WHERE reader_id = ? AND source_alias IN (SELECT value FROM json_each(?))", id, JSON.stringify(removed)]);
    }
  }
  if (statements.length === 0) return;
  try {
    // The log row comes first, so it keeps the name the account had before the change.
    await ctx.db.batch([recordFound(actor, `${role}.updated`, role, userFound(role, id), changed), ...statements]);
  } catch (error) {
    conflict(error);
  }
}

const LAST_ADMIN = "This is the last active administrator. Add or reactivate another one first; whoever holds the root password can still do this at /root/setup.";

/**
 * Calls the operation off when `id` is the only administrator who can still
 * sign in. Root is not held by it: root can always make an administrator again.
 */
function keepOneAdmin(actor: Actor, role: Role, id: string): Statement[] {
  if (role !== "admin" || actor.role === "root") return [];
  return [guard(
    "EXISTS (SELECT 1 FROM admins WHERE id = ? AND suspended_at IS NULL) AND NOT EXISTS (SELECT 1 FROM admins WHERE id <> ? AND suspended_at IS NULL)", id, id,
  )];
}

/**
 * Sessions, keys, access links and permissions are removed explicitly in the
 * same operation: the system does not rely on cascading deletes being enabled
 * in the database.
 */
export async function deleteAccount(ctx: Ctx, actor: Actor, role: Role, id: string): Promise<void> {
  const { table, column } = TABLE[role];
  const statements: Statement[] = [
    ...keepOneAdmin(actor, role, id),
    recordFound(actor, `${role}.removed`, role, userFound(role, id)),
    [`DELETE FROM sessions WHERE ${column} = ?`, id],
    [`DELETE FROM api_keys WHERE ${column} = ?`, id],
  ];
  if (role === "reader") statements.push(["DELETE FROM permissions WHERE reader_id = ?", id], ["DELETE FROM invites WHERE reader_id = ?", id]);
  statements.push([`DELETE FROM ${table} WHERE id = ? RETURNING id`, id]);
  let results: Row[][];
  try {
    results = await ctx.db.batch(statements);
  } catch (error) {
    if (guardRefused(error)) throw new HttpError(409, LAST_ADMIN);
    throw error;
  }
  if ((results.at(-1) ?? []).length === 0) throw new HttpError(404, "User not found.");
}

/**
 * Suspends an account, or lets it back in. A suspended account keeps its
 * permissions, its props and its keys, and can do nothing with them: its
 * sessions end at once, and it cannot sign in, use a key or use an access link.
 */
export async function setSuspended(ctx: Ctx, actor: Actor, role: Role, id: string, suspended: boolean): Promise<void> {
  const { table, column } = TABLE[role];
  const found = userFound(role, id);
  let results: Row[][];
  try {
    results = await ctx.db.batch(suspended
      ? [
          [`SELECT id FROM ${table} WHERE id = ?`, id],
          ...keepOneAdmin(actor, role, id),
          // Suspending what is already suspended changes nothing and writes nothing.
          recordFound(actor, `${role}.suspended`, role, { ...found, from: `${found.from} AND u.suspended_at IS NULL` }),
          [`UPDATE ${table} SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL`, Date.now(), id],
          [`DELETE FROM sessions WHERE ${column} = ?`, id],
        ]
      : [
          [`SELECT id FROM ${table} WHERE id = ?`, id],
          recordFound(actor, `${role}.reactivated`, role, { ...found, from: `${found.from} AND u.suspended_at IS NOT NULL` }),
          [`UPDATE ${table} SET suspended_at = NULL WHERE id = ?`, id],
        ]);
  } catch (error) {
    if (guardRefused(error)) throw new HttpError(409, LAST_ADMIN);
    throw error;
  }
  if ((results[0] ?? []).length === 0) throw new HttpError(404, "User not found.");
}

/** Wrong current passwords accepted in fifteen minutes when changing a password. */
const PASSWORD_CHANGE_ATTEMPTS = 5;

/**
 * Whoever is signed in changes their own password, by saying the current one.
 * Their other sessions end; the one they are using stays. Not with an API key:
 * a key that could change the password would be worth the whole account.
 */
export async function changeOwnPassword(ctx: Ctx, session: Session, input: Input): Promise<void> {
  if (session.viaKey || session.sid === null) throw new HttpError(403, "The password is changed signed in with it, not with an API key.");
  const { role, user, actor } = session;
  const { table, column } = TABLE[role];
  const master = ctx.secrets.get(SECRET_MASTER);
  const current = typeof input.current_password === "string" ? input.current_password.slice(0, 256) : "";
  const now = Date.now();
  // Someone who took over a session must not be able to guess the password through this.
  const limits: Limit[] = [{ key: `password:${role}:${user.id}`, max: PASSWORD_CHANGE_ATTEMPTS }];
  const [counted = [], accounts = []] = await ctx.db.batch([
    countAttempts(limits, now),
    [`SELECT password_hash${role === "reader" ? ", email" : ""} FROM ${table} WHERE id = ?`, user.id],
  ]);
  const account = accounts[0];
  if (!account) throw new HttpError(404, "User not found.");
  if (overLimit(counted, limits, true)) throw new HttpError(429, "Too many attempts. Wait fifteen minutes and try again.");
  if (!(await verifyPassword(master, current, String(account.password_hash)))) {
    await ctx.db.batch([record(actor, "login.failed", null, { reason: "wrong current password" })]);
    throw new HttpError(403, "The current password is not right.");
  }
  const chosen = password(input.new_password, [user.username, typeof account.email === "string" ? account.email : null]);
  if (chosen === current) throw new HttpError(400, "The new password is the same as the current one.");
  await ctx.db.batch([
    record(actor, "password.changed", { type: role, id: user.id, name: user.username }),
    [`UPDATE ${table} SET password_hash = ? WHERE id = ?`, await hashPassword(master, chosen), user.id],
    [`DELETE FROM sessions WHERE ${column} = ? AND id <> ?`, user.id, session.sid],
    forgetAttempts(limits[0]!.key),
  ]);
}

// ---------------------------------------------------------------------------
// Two-step verification: each account turns it on for itself. For
// administrators it is always a choice; for readers, an administrator can
// make it required.
// ---------------------------------------------------------------------------

export interface TwoStep {
  /** Signing in asks for a code. */
  enabled: boolean;
  enabled_at: number | null;
  /** Setup was started and not finished: `secret` is waiting to be confirmed with a code. */
  pending: boolean;
  /** Only while `pending`: the key to add to the authenticator app. Once confirmed it is never shown again. */
  secret?: string;
  /** Readers only: an administrator decided that every reader uses it. */
  required: boolean;
}

const MFA_COLUMNS = "mfa_secret, mfa_enabled_at";

/** The signed-in account's own two-step verification, read with the session check. */
export function twoStepQuery(role: Role, user: UserRef): Statement {
  return [`SELECT ${MFA_COLUMNS}, ${role === "reader" ? READER_TWO_STEP_REQUIRED : "0"} AS required FROM ${TABLE[role].table} WHERE id = ${user.sql}`, ...user.params];
}

export async function twoStep(ctx: Ctx, session: Session, rows: Row[] | undefined): Promise<TwoStep> {
  const row = rows?.[0];
  const required = row?.required === 1;
  const enabled_at = typeof row?.mfa_enabled_at === "number" ? row.mfa_enabled_at : null;
  if (enabled_at !== null || typeof row?.mfa_secret !== "string") return { enabled: enabled_at !== null, enabled_at, pending: false, required };
  const secret = await openMfaSecret(ctx.secrets.get(SECRET_MASTER), row.mfa_secret, session.user.id);
  // A key that no longer opens (the master key changed) is as good as none: setup starts again.
  return secret === null ? { enabled: false, enabled_at: null, pending: false, required } : { enabled: false, enabled_at: null, pending: true, secret, required };
}

function clearMfa(role: Role, id: string): Statement {
  return [`UPDATE ${TABLE[role].table} SET mfa_secret = NULL, mfa_enabled_at = NULL, mfa_last_step = 0 WHERE id = ? RETURNING id`, id];
}

/** Two-step verification belongs to whoever is signed in with their password: an API key cannot touch it. */
function ownTwoStep(session: Session): { sid: string } {
  if (session.viaKey || session.sid === null) throw new HttpError(403, "Two-step verification is managed signed in with your password, not with an API key.");
  return { sid: session.sid };
}

/**
 * The current password, said again: someone who took over a session must not
 * be able to turn two-step verification on (locking the owner out) or off.
 * Wrong ones are counted together with those of `changeOwnPassword`.
 */
async function confirmOwnPassword(ctx: Ctx, session: Session, input: Input): Promise<Row> {
  const { role, user, actor } = session;
  const current = typeof input.current_password === "string" ? input.current_password.slice(0, 256) : "";
  const limits: Limit[] = [{ key: `password:${role}:${user.id}`, max: PASSWORD_CHANGE_ATTEMPTS }];
  const [counted = [], accounts = []] = await ctx.db.batch([
    countAttempts(limits, Date.now()),
    [`SELECT password_hash, ${MFA_COLUMNS} FROM ${TABLE[role].table} WHERE id = ?`, user.id],
  ]);
  const account = accounts[0];
  if (!account) throw new HttpError(404, "User not found.");
  if (overLimit(counted, limits, true)) throw new HttpError(429, "Too many attempts. Wait fifteen minutes and try again.");
  if (!(await verifyPassword(ctx.secrets.get(SECRET_MASTER), current, String(account.password_hash)))) {
    await ctx.db.batch([record(actor, "login.failed", null, { reason: "wrong current password" })]);
    throw new HttpError(403, "The current password is not right.");
  }
  await ctx.db.batch([forgetAttempts(limits[0]!.key)]);
  return account;
}

/**
 * First half of turning it on: with the current password, a new key is made
 * for the authenticator app. Nothing changes at sign-in until `confirmTwoStep`
 * proves the app has the key. Starting again replaces a key never confirmed.
 */
export async function startTwoStep(ctx: Ctx, session: Session, input: Input): Promise<{ secret: string }> {
  ownTwoStep(session);
  const account = await confirmOwnPassword(ctx, session, input);
  if (account.mfa_enabled_at !== null) throw new HttpError(409, "Two-step verification is already on. Turn it off first to set it up again.");
  const { role, user, actor } = session;
  const secret = newMfaSecret();
  await ctx.db.batch([
    record(actor, "mfa.setup", { type: role, id: user.id, name: user.username }),
    [`UPDATE ${TABLE[role].table} SET mfa_secret = ? WHERE id = ? AND mfa_enabled_at IS NULL`, await sealMfaSecret(ctx.secrets.get(SECRET_MASTER), secret, user.id), user.id],
  ]);
  return { secret };
}

/**
 * Second half: a code from the app turns it on. From here on, signing in asks
 * for a code. Every other session of the account ends: they were opened
 * without one.
 */
export async function confirmTwoStep(ctx: Ctx, session: Session, input: Input): Promise<void> {
  const { sid } = ownTwoStep(session);
  const { role, user, actor } = session;
  const { table, column } = TABLE[role];
  const [row] = await ctx.db.query(`SELECT ${MFA_COLUMNS} FROM ${table} WHERE id = ?`, user.id);
  if (row && row.mfa_enabled_at !== null) throw new HttpError(409, "Two-step verification is already on.");
  const stored = typeof row?.mfa_secret === "string" ? row.mfa_secret : null;
  const secret = stored === null ? null : await openMfaSecret(ctx.secrets.get(SECRET_MASTER), stored, user.id);
  if (stored === null || secret === null) throw new HttpError(409, "Start the setup first: there is no key waiting to be confirmed.");
  const now = Date.now();
  const code = typeof input.code === "string" ? input.code.replace(/\s+/g, "").slice(0, 16) : "";
  const step = await matchMfaCode(secret, code, now);
  if (step === null) {
    throw new HttpError(400, "The code is not right. Check that your phone's clock is set automatically, wait for the next code and try again.");
  }
  // Only the key that was just proved is turned on: a setup started again in the meantime is left alone.
  const mine = "id = ? AND mfa_enabled_at IS NULL AND mfa_secret = ?";
  const [, changed = []] = await ctx.db.batch([
    recordFound(actor, "mfa.enabled", role, { from: `${table} u WHERE u.${mine}`, params: [user.id, stored], id: "u.id", name: "u.username" }),
    [`UPDATE ${table} SET mfa_enabled_at = ?, mfa_last_step = ? WHERE ${mine} RETURNING id`, now, step, user.id, stored],
    [`DELETE FROM sessions WHERE ${column} = ? AND id <> ? AND EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND mfa_enabled_at = ?)`, user.id, sid, user.id, now],
  ]);
  if (changed.length === 0) throw new HttpError(409, "The setup changed while you were confirming it. Open Your account and try again.");
}

/**
 * Turns it off, or gives up a setup that was never confirmed. Turning off what
 * is on asks for the current password; a lost phone is someone else's to
 * solve (see `resetTwoStep`). A reader of whom it is required can turn it off
 * too, to move to another phone: they set it up again before doing anything else.
 */
export async function disableTwoStep(ctx: Ctx, session: Session, input: Input): Promise<void> {
  ownTwoStep(session);
  const { role, user, actor } = session;
  const [row] = await ctx.db.query(`SELECT ${MFA_COLUMNS} FROM ${TABLE[role].table} WHERE id = ?`, user.id);
  if (!row || row.mfa_secret === null) throw new HttpError(409, "Two-step verification is not on.");
  const enabled = row.mfa_enabled_at !== null;
  if (enabled) await confirmOwnPassword(ctx, session, input);
  await ctx.db.batch([
    record(actor, "mfa.disabled", { type: role, id: user.id, name: user.username }, enabled ? {} : { setup: "cancelled" }),
    clearMfa(role, user.id),
  ]);
}

/**
 * The way back in for someone who lost their phone: their two-step
 * verification is turned off, by whoever holds the root password for an
 * administrator, and by any administrator for a reader. Their password stays
 * as it is, and so do their sessions.
 */
export async function resetTwoStep(ctx: Ctx, actor: Actor, role: Role, id: string): Promise<void> {
  if (actor.role !== "root" && !(role === "reader" && actor.role === "admin")) {
    throw new HttpError(403, role === "admin"
      ? "Only whoever holds the root password turns off another account's two-step verification."
      : "Only an administrator turns off a reader's two-step verification.");
  }
  const found = userFound(role, id);
  const results = await ctx.db.batch([
    // Turning off what is not on changes nothing and writes nothing.
    recordFound(actor, "mfa.disabled", role, { ...found, from: `${found.from} AND u.mfa_secret IS NOT NULL` }),
    clearMfa(role, id),
  ]);
  if ((results.at(-1) ?? []).length === 0) throw new HttpError(404, "User not found.");
}

/** What the administrators decided about the readers, and how many readers have no two-step verification yet. */
export const READER_SETTINGS: Statement = [
  `SELECT ${READER_TWO_STEP_REQUIRED} AS two_step_required, (SELECT COUNT(*) FROM readers WHERE mfa_enabled_at IS NULL) AS without_two_step`,
];

export interface ReaderSettings {
  /** Every reader must set up two-step verification: one who has not can do nothing else once signed in. */
  two_step_required: boolean;
  /** Readers who have not turned it on. */
  readers_without_two_step: number;
}

export function readerSettings(rows: Row[] | undefined): ReaderSettings {
  return { two_step_required: rows?.[0]?.two_step_required === 1, readers_without_two_step: Number(rows?.[0]?.without_two_step ?? 0) };
}

/**
 * It holds from the next request on: a reader without two-step verification
 * who is signed in is sent to set it up, and their API keys answer 403 until
 * they do. Nobody is signed out.
 */
export async function setReaderSettings(ctx: Ctx, actor: Actor, input: Input): Promise<void> {
  const required = input.two_step_required;
  if (typeof required !== "boolean") throw new HttpError(400, '"two_step_required" must be true or false.');
  await ctx.db.batch([
    record(actor, "settings.updated", null, { reader_two_step_required: required }),
    setSetting(READER_TWO_STEP_KEY, required ? "1" : "0", Date.now()),
  ]);
}

// ---------------------------------------------------------------------------
// Access links: how a reader chooses their password
// ---------------------------------------------------------------------------

/** The link is `/reader/invite/<token>`. Only a hash of the token is stored, so it appears once. */
export interface Invite {
  token: string;
  expires_at: number;
}

interface IssuedInvite extends Invite {
  statements: Statement[];
}

const INVALID_INVITE = "This link is not valid any more: it was already used, replaced or has expired. Ask your administrator for a new one.";

/**
 * A link that does not work is written down once an hour for each address it
 * comes from, and never with the link: it may be a reader with an old link,
 * or someone trying links.
 */
async function invalidInvite(ctx: Ctx, request: Request): Promise<never> {
  const ip = ipOf(ctx, request);
  await ctx.db.batch([recordOnce(visitor(ip, "link"), "invite.invalid", `invite:${ip ?? "unknown"}:${hourOf(Date.now())}`)]);
  throw new HttpError(404, INVALID_INVITE);
}

/** A reader has one link at a time: a new one replaces the one before it. */
async function issueInvite(ctx: Ctx, actor: Actor, readerId: string, now: number): Promise<IssuedInvite> {
  const token = newInviteToken();
  const expires_at = now + INVITE_MS;
  return {
    token, expires_at,
    statements: [
      recordFound(actor, "reader.invite.created", "reader", userFound("reader", readerId), { expires_at }),
      ["DELETE FROM invites WHERE reader_id = ?", readerId],
      [
        "INSERT INTO invites (reader_id, token_hash, created_at, expires_at) SELECT id, ?, ?, ? FROM readers WHERE id = ? RETURNING reader_id",
        await hashInvite(ctx.secrets.get(SECRET_MASTER), token), now, expires_at, readerId,
      ],
    ],
  };
}

/**
 * A new link for a reader who already exists: for one who never chose a
 * password, or to let one choose a new password. The current password keeps
 * working until the link is used.
 */
export async function createInvite(ctx: Ctx, actor: Actor, readerId: string): Promise<Invite & { username: string; email: string | null }> {
  const invite = await issueInvite(ctx, actor, readerId, Date.now());
  const results = await ctx.db.batch([...invite.statements, ["SELECT username, email FROM readers WHERE id = ?", readerId]]);
  const reader = results.at(-1)?.[0];
  if (!reader) throw new HttpError(404, "User not found.");
  return { token: invite.token, expires_at: invite.expires_at, username: String(reader.username), email: typeof reader.email === "string" ? reader.email : null };
}

export async function revokeInvite(ctx: Ctx, actor: Actor, readerId: string): Promise<void> {
  const [, removed = []] = await ctx.db.batch([
    recordFound(actor, "reader.invite.revoked", "reader", { from: "invites i JOIN readers u ON u.id = i.reader_id WHERE i.reader_id = ?", params: [readerId], id: "u.id", name: "u.username" }),
    ["DELETE FROM invites WHERE reader_id = ? RETURNING reader_id", readerId],
  ]);
  if (removed.length === 0) throw new HttpError(404, "This reader has no access link waiting to be used.");
}

/** The address a reader opens to choose their password. */
export function inviteUrl(ctx: Ctx, request: Request, token: string): string {
  return `${publicOrigin(request, ctx.config)}/reader/invite/${token}`;
}

/**
 * Whose link this is. Whoever holds the link is not signed in: the name and
 * the expiry are all they learn. `hash` is how the database knows the link.
 */
export async function findInvite(
  ctx: Ctx, request: Request, token: string,
): Promise<{ id: string; username: string; email: string | null; expires_at: number; hash: string; two_step: boolean; twoStepOwed: boolean }> {
  const hash = await hashInvite(ctx.secrets.get(SECRET_MASTER), token.slice(0, 128));
  const [row] = await ctx.db.query(
    `SELECT u.id, u.username, u.email, i.expires_at, u.mfa_enabled_at, ${TWO_STEP_OWED} AS two_step_owed FROM invites i JOIN readers u ON u.id = i.reader_id WHERE i.token_hash = ? AND i.expires_at > ? AND u.suspended_at IS NULL`,
    hash, Date.now(),
  );
  if (!row) return invalidInvite(ctx, request);
  return {
    id: String(row.id), username: String(row.username), email: typeof row.email === "string" ? row.email : null, expires_at: Number(row.expires_at), hash,
    two_step: row.mfa_enabled_at !== null, twoStepOwed: row.two_step_owed === 1,
  };
}

/**
 * The reader chooses their password. The link stops working in the same
 * operation, every earlier session of the reader ends, and a new one starts:
 * they are signed in. Not so for a reader with two-step verification on: the
 * link is no substitute for the code, so `cookie` is `null` and they sign in
 * with the new password and a code. A reader of whom it is required, and who
 * has not set it up, leaves with the setup already started (`twoStepOwed`).
 */
export async function acceptInvite(ctx: Ctx, request: Request, token: string, input: Input): Promise<Omit<LoginResult, "cookie"> & { cookie: string | null }> {
  await requireSameOrigin(ctx, request);
  const reader = await findInvite(ctx, request, token);
  const hash = await hashPassword(ctx.secrets.get(SECRET_MASTER), password(input.password, [reader.username, reader.email]));
  const tokenHash = reader.hash;
  const now = Date.now();
  const sid = randomId();
  const actor: Actor = { role: "reader", id: reader.id, name: reader.username, via: "link", ip: ipOf(ctx, request) };
  // Every statement checks the link again: of two requests with the same link, only one finds it.
  const valid = "(SELECT reader_id FROM invites WHERE token_hash = ? AND expires_at > ?)";
  // A reader who owes two-step verification starts setting it up here: they
  // have just chosen the password, so asking for it again would prove nothing.
  // The key waits, unused at sign-in, until a code from the app confirms it.
  const setup: Statement[] = !reader.twoStepOwed ? [] : [
    recordFound(actor, "mfa.setup", "reader", { from: `readers u WHERE u.id = ${valid} AND u.mfa_enabled_at IS NULL`, params: [tokenHash, now], id: "u.id", name: "u.username" }),
    [`UPDATE readers SET mfa_secret = ? WHERE id = ${valid} AND mfa_enabled_at IS NULL`, await sealMfaSecret(ctx.secrets.get(SECRET_MASTER), newMfaSecret(), reader.id), tokenHash, now],
  ];
  const [, changed = []] = await ctx.db.batch([
    recordFound(actor, "reader.password.set", "reader", { from: `readers u WHERE u.id = ${valid}`, params: [tokenHash, now], id: "u.id", name: "u.username" }),
    [`UPDATE readers SET password_hash = ? WHERE id = ${valid} RETURNING id`, hash, tokenHash, now],
    [`DELETE FROM sessions WHERE reader_id = ${valid}`, tokenHash, now],
    [`INSERT INTO sessions (id, reader_id, created_at, expires_at) SELECT ?, reader_id, ?, ? FROM invites WHERE token_hash = ? AND expires_at > ? AND EXISTS (SELECT 1 FROM readers u WHERE u.id = reader_id AND u.mfa_enabled_at IS NULL)`, sid, now, now + SESSION_MS, tokenHash, now],
    ...setup,
    ["DELETE FROM invites WHERE token_hash = ?", tokenHash],
  ]);
  if (changed.length === 0) return invalidInvite(ctx, request);
  const user = { id: reader.id, username: reader.username };
  if (reader.two_step) return { cookie: null, user, twoStepOwed: false };
  const cookie = await signToken(ctx.secrets.get(SECRET_SIGNING), { sid, sub: reader.id, role: "reader", exp: Math.floor((now + SESSION_MS) / 1000) });
  return { cookie: sessionCookie("reader", cookie, SESSION_MS / 1000), user, twoStepOwed: reader.twoStepOwed };
}

// ---------------------------------------------------------------------------
// Platform and reader props
// ---------------------------------------------------------------------------

export const PLATFORM_PROPS: Statement = ["SELECT props FROM platform WHERE id = 1"];

export function platformProps(rows: Row[] | undefined): Record<string, unknown> {
  return parseObject(rows?.[0]?.props);
}

/** The log says which keys the props have now, not their values: props can be large. */
function propKeys(text: string): { keys: string[] } {
  return { keys: Object.keys(parseObject(text)).slice(0, 50) };
}

export async function setPlatformProps(ctx: Ctx, actor: Actor, value: unknown): Promise<void> {
  const text = propsText(value);
  await ctx.db.batch([
    [
      "INSERT INTO platform (id, props, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET props = excluded.props, updated_at = excluded.updated_at",
      text, Date.now(),
    ],
    record(actor, "platform.props.updated", { type: "platform", id: null, name: null }, propKeys(text)),
  ]);
}

/**
 * Replaces all the props of a reader. Called by the reader, for their own, and
 * by an administrator, for any reader: the log says which of the two it was.
 */
export async function setReaderProps(ctx: Ctx, actor: Actor, readerId: string, value: unknown): Promise<void> {
  const text = propsText(value);
  const results = await ctx.db.batch([
    recordFound(actor, "reader.props.updated", "reader", userFound("reader", readerId), propKeys(text)),
    ["UPDATE readers SET props = ? WHERE id = ? RETURNING id", text, readerId],
  ]);
  if ((results.at(-1) ?? []).length === 0) throw new HttpError(404, "User not found.");
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface ApiKey {
  id: string;
  /** What the owner called it ("backup script"), to tell keys apart. */
  name: string | null;
  created_at: number;
  /** When it stops working; `null` for a key that never expires. */
  expires_at: number | null;
  /** When it was last used, to the hour; `null` for a key never used. */
  last_used_at: number | null;
}

const KEY_COLUMNS = "id, name, created_at, expires_at, last_used_at";
/** The longest life a key can be given, in days. */
export const KEY_MAX_DAYS = 3650;

function toApiKey(row: Row): ApiKey {
  const time = (value: SqlValue | undefined): number | null => (typeof value === "number" ? value : null);
  return { id: String(row.id), name: typeof row.name === "string" ? row.name : null, created_at: Number(row.created_at), expires_at: time(row.expires_at), last_used_at: time(row.last_used_at) };
}

export function apiKeysQuery(role: Role, user: UserRef): Statement {
  return [`SELECT ${KEY_COLUMNS} FROM api_keys WHERE ${TABLE[role].column} = ${user.sql} ORDER BY created_at DESC`, ...user.params];
}

export function apiKeys(rows: Row[] | undefined): ApiKey[] {
  return (rows ?? []).map(toApiKey);
}

/**
 * The key itself appears only here, once: the database stores only its hash.
 * `name` says what the key is for; `expires_in_days` gives it an end (without
 * it, the key works until it is revoked).
 */
export async function createApiKey(ctx: Ctx, actor: Actor, role: Role, ownerId: string, input: Input = {}): Promise<ApiKey & { key: string }> {
  let name: string | null = null;
  if (input.name !== undefined && input.name !== null && input.name !== "") {
    if (typeof input.name !== "string" || input.name.trim().length > 60) throw new HttpError(400, "The name of a key has up to 60 characters.");
    name = input.name.trim() || null;
  }
  let days: number | null = null;
  if (input.expires_in_days !== undefined && input.expires_in_days !== null && input.expires_in_days !== "") {
    days = typeof input.expires_in_days === "string" && /^\d{1,5}$/.test(input.expires_in_days) ? Number(input.expires_in_days) : (input.expires_in_days as number);
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > KEY_MAX_DAYS) {
      throw new HttpError(400, `"expires_in_days" must be a whole number from 1 to ${KEY_MAX_DAYS}.`);
    }
  }
  const key = newApiKey(role);
  const now = Date.now();
  const created: ApiKey = { id: randomId(), name, created_at: now, expires_at: days === null ? null : now + days * DAY_MS, last_used_at: null };
  await ctx.db.batch([
    [
      `INSERT INTO api_keys (id, key_hash, ${TABLE[role].column}, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      created.id, await hashApiKey(ctx.secrets.get(SECRET_MASTER), key), ownerId, name, now, created.expires_at,
    ],
    record(actor, "api_key.created", { type: "api_key", id: created.id, name }, { owner_role: role, owner_id: ownerId, ...(created.expires_at === null ? {} : { expires_at: created.expires_at }) }),
  ]);
  return { ...created, key };
}

export async function deleteApiKey(ctx: Ctx, actor: Actor, role: Role, ownerId: string, keyId: string): Promise<void> {
  const { table, column } = TABLE[role];
  const [, removed = []] = await ctx.db.batch([
    recordFound(actor, "api_key.revoked", "api_key", {
      from: `api_keys k JOIN ${table} u ON u.id = k.${column} WHERE k.id = ? AND k.${column} = ?`, params: [keyId, ownerId], id: "k.id", name: "u.username",
    }, { owner_role: role, owner_id: ownerId }),
    [`DELETE FROM api_keys WHERE id = ? AND ${column} = ? RETURNING id`, keyId, ownerId],
  ]);
  if (removed.length === 0) throw new HttpError(404, "Key not found.");
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Newest first. Filters: `action` (exact), `action_prefix` ("reader." for all
 * the reader actions), `actor` (name prefix), `actor_id`, `target` (the id of
 * what was changed), `created_from`, `created_to`. `before` continues a
 * listing: it takes the `next_before` of the page before. The log only grows,
 * so it is paged by position and not by page number.
 */
export function listAuditQuery(filters: URLSearchParams): Statement {
  const where: string[] = [];
  const params: SqlParam[] = [];
  for (const [name, column] of [["action", "action"], ["actor_id", "actor_id"], ["target", "target_id"]] as const) {
    const value = filters.get(name);
    if (value) (where.push(`${column} = ?`), params.push(value));
  }
  for (const [name, column] of [["action_prefix", "action"], ["actor", "actor_name"]] as const) {
    const value = filters.get(name);
    if (value) (where.push(`${column} >= ? AND ${column} < ?`), params.push(value, `${value}\uffff`));
  }
  const from = dateFilter(filters.get("created_from"), false);
  const to = dateFilter(filters.get("created_to"), true);
  if (from !== null) (where.push("at >= ?"), params.push(from));
  if (to !== null) (where.push("at <= ?"), params.push(to));
  const before = filters.get("before");
  if (before) {
    if (!/^\d{1,15}$/.test(before)) throw new HttpError(400, "Invalid `before`: use the `next_before` of the page before.");
    (where.push("id < ?"), params.push(Number(before)));
  }
  return [`SELECT * FROM audit_log${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`, ...params, PAGE_SIZE + 1];
}

/** Entries in one exported file. A longer log is exported in parts: see `next_before`. */
export const EXPORT_ROWS = 5000;

/** A value as a CSV cell. One that a spreadsheet would run as a formula gets an apostrophe in front. */
function csvCell(column: string): string {
  const value = `COALESCE(${column}, '')`;
  return `'"' || replace(CASE WHEN substr(${value}, 1, 1) IN ('=', '+', '-', '@', char(9), char(13)) THEN '''' || ${value} ELSE ${value} END, '"', '""') || '"'`;
}

export const AUDIT_CSV_HEADER = "id,at_utc,actor_role,actor_id,actor_name,via,ip,action,target_type,target_id,target_name,details";

/**
 * The same listing as `listAuditQuery`, with each entry already written as a
 * CSV line by the database. The second statement writes down that the log was
 * exported, by whom, with which filters and how many entries.
 */
export function exportAuditQueries(actor: Actor, filters: URLSearchParams): Statement[] {
  const [listing, ...params] = listAuditQuery(filters);
  const limited = params.slice(0, -1);
  const rows = listing.replace("SELECT *", "SELECT id").replace(/LIMIT \?$/, `LIMIT ${EXPORT_ROWS + 1}`);
  const line = ["id", "strftime('%Y-%m-%dT%H:%M:%SZ', at / 1000, 'unixepoch')",
    ...["actor_role", "actor_id", "actor_name", "via", "ip", "action", "target_type", "target_id", "target_name", "details"].map(csvCell)].join(" || ',' || ");
  const used: Record<string, string> = {};
  for (const [name, value] of filters) used[name.slice(0, 40)] = value.slice(0, 200);
  return [
    [`SELECT id, ${line} AS line FROM audit_log WHERE id IN (${rows}) ORDER BY id DESC`, ...limited],
    [
      "INSERT INTO audit_log (at, actor_role, actor_id, actor_name, via, ip, action, details) " +
        `SELECT ?, ?, ?, ?, ?, ?, 'audit.exported', json_object('rows', MIN(COUNT(*), ${EXPORT_ROWS}), 'filters', json(?)) FROM (${rows})`,
      Date.now(), actor.role, actor.id, actor.name.slice(0, 64), actor.via, actor.ip, JSON.stringify(used), ...limited,
    ],
  ];
}

/** The file, and what to send as `before` for the next part (`null` when this is the last). */
export function auditCsv(rows: Row[]): { text: string; next_before: number | null } {
  const lines = rows.slice(0, EXPORT_ROWS).map((row) => String(row.line));
  // The byte order mark is what makes a spreadsheet read the accents right.
  return { text: `﻿${[AUDIT_CSV_HEADER, ...lines].join("\r\n")}\r\n`, next_before: rows.length > EXPORT_ROWS ? Number(rows[EXPORT_ROWS - 1]!.id) : null };
}

export interface AuditPage {
  items: AuditEntry[];
  /** What to send as `before` to read the older entries; `null` at the end. */
  next_before: number | null;
}

export function auditPage(rows: Row[]): AuditPage {
  const items = rows.slice(0, PAGE_SIZE).map(toAuditEntry);
  return { items, next_before: rows.length > PAGE_SIZE ? (items.at(-1)?.id ?? null) : null };
}

// ---------------------------------------------------------------------------
// A reader's sources
// ---------------------------------------------------------------------------

/** The sources the reader can open: those granted to them and every public one. */
export function readableSourcesQuery(user: UserRef): Statement {
  return [
    `SELECT s.alias, s.public FROM sources s WHERE s.public = 1 OR EXISTS (SELECT 1 FROM permissions p WHERE p.source_alias = s.alias AND p.reader_id = ${user.sql}) ORDER BY s.alias`,
    ...user.params,
  ];
}

/**
 * The audit rows of a signed-in reader asking for a source, written with the
 * reads of the same request: `read` when the source is private and theirs to
 * open, `denied` when it is not (or does not exist). Once an hour for each
 * reader and source, however many files they open.
 */
export function sourceAccessRows(ctx: Ctx, request: Request, alias: string, user: UserRef): { read: Statement; denied: Statement } {
  const now = Date.now();
  const hour = hourOf(now);
  const ip = ipOf(ctx, request);
  // What is asked for is typed by the reader: only something shaped like an alias is written down.
  const name = ALIAS.test(alias) ? alias.slice(0, 64) : "(invalid)";
  const allowed = "EXISTS (SELECT 1 FROM permissions p WHERE p.source_alias = s.alias AND p.reader_id = u.id)";
  const columns = "(at, actor_role, actor_id, actor_name, via, ip, action, target_type, target_id, target_name, dedupe)";
  return {
    read: [
      `INSERT OR IGNORE INTO audit_log ${columns} SELECT ?, 'reader', u.id, u.username, ?, ?, 'source.read', 'source', s.alias, s.alias, 'read:' || u.id || ':' || s.alias || ':' || ? ` +
        `FROM readers u JOIN sources s ON s.alias = ? WHERE u.id = ${user.sql} AND s.public = 0 AND ${allowed}`,
      now, user.via, ip, hour, alias, ...user.params,
    ],
    denied: [
      `INSERT OR IGNORE INTO audit_log ${columns} SELECT ?, 'reader', u.id, u.username, ?, ?, 'source.denied', 'source', NULL, ?, 'denied:' || u.id || ':' || ? || ':' || ? ` +
        `FROM readers u WHERE u.id = ${user.sql} AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.alias = ? AND (s.public = 1 OR ${allowed}))`,
      now, user.via, ip, name, name, hour, ...user.params, alias,
    ],
  };
}

export function readableSources(rows: Row[] | undefined): { alias: string; public: boolean }[] {
  return (rows ?? []).map((row) => ({ alias: String(row.alias), public: row.public === 1 }));
}
