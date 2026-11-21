// The core of Gatefold: database schema, authentication and the operations the
// pages and the API share. No route is defined here.
import type { Database, SqlParam, SqlValue } from "../deps/databases.ts";
import type { Secrets } from "../deps/secrets.ts";
import type { Sites } from "../deps/sites.ts";
import { type Actor, type AuditEntry, type Found, SYSTEM, record, recordAs, recordFound, rootActor, toAuditEntry } from "./audit.ts";
import { type Config, clientIp, publicOrigin, sameOrigin } from "./config.ts";
import {
  type Claims, type Role, SECRET_MASTER, SECRET_ROOT, SECRET_SIGNING, clearCookie, cookieName, hashApiKey, hashInvite, hashPassword,
  newApiKey, newInviteToken, randomId, readCookie, safeEqual, sessionCookie, signToken, verifyPassword, verifyToken,
} from "./security.ts";
import { DEFAULT_RENDER, MAX_PROPS, SOURCES_FOLDER, loadSourceConfig } from "./source-config.ts";

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
];

/** How long a login session lasts. */
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long the link that lets a reader choose their password works. Short on
 * purpose: until it is used, the link is a password in an address.
 */
export const INVITE_MS = 72 * 60 * 60 * 1000;
/** Wrong root password attempts accepted per hour, counting all visitors together. */
export const ROOT_ATTEMPTS_PER_HOUR = 5;
/** Items per page in listings. */
export const PAGE_SIZE = 50;

const HOUR_MS = 60 * 60 * 1000;

export interface Ctx {
  db: Database;
  sites: Sites;
  secrets: Secrets;
  /** The installation's sites/gatefold.json, read before the first request is handled (see main.ts). */
  config: Config;
}

/** The visitor's address, from the source the installation trusts. */
export function ipOf(ctx: Ctx, request: Request): string | null {
  return clientIp(request, ctx.config);
}

/** A change made with a cookie, a password or a link only counts if the browser says it came from this site. */
export function requireSameOrigin(ctx: Ctx, request: Request): void {
  if (!sameOrigin(request, ctx.config)) throw new HttpError(403, "Request refused: it did not come from this site.");
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

/**
 * The folders of sites/sources/ in this publication that can be a source. The
 * list is taken when the app is built, so reading it costs nothing.
 */
export function detectedAliases(ctx: Ctx): string[] {
  return ctx.sites.folders(SOURCES_FOLDER).filter((name) => ALIAS.test(name));
}

/** Folders of sites/sources/ that are not sources because of their name. */
export function ignoredFolders(ctx: Ctx): string[] {
  return ctx.sites.folders(SOURCES_FOLDER).filter((name) => !ALIAS.test(name));
}

/**
 * Every folder of sites/sources/ is a source without anyone registering it:
 * this statement gives each new one its row, private and with no permissions.
 * Rows that already exist are left as they are. It runs with every
 * administrator request, in the same database round trip. The first statement
 * writes each new folder down in the audit log.
 */
export function syncSources(ctx: Ctx): Statement[] {
  const aliases = JSON.stringify(detectedAliases(ctx));
  return [
    recordFound(SYSTEM, "source.detected", "source", { from: "json_each(?) WHERE value NOT IN (SELECT alias FROM sources)", params: [aliases], id: "value", name: "value" }),
    ["INSERT OR IGNORE INTO sources (alias, public, created_at) SELECT value, 0, ? FROM json_each(?)", Date.now(), aliases],
  ];
}

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
  /** The same person, as the audit log writes them down. */
  actor: Actor;
  /** Rows of the reads requested together with the session check. */
  rows: Row[][];
}

/** How SQL reaches the authenticated user's identifier, before the database has answered. */
export interface UserRef {
  sql: string;
  params: SqlParam[];
}

type Credential = { kind: "session"; claims: Claims } | { kind: "key"; hash: string };

const TABLE: Record<Role, { table: string; column: string; extra: string }> = {
  admin: { table: "admins", column: "admin_id", extra: "" },
  reader: { table: "readers", column: "reader_id", extra: ", u.props" },
};

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
 */
export async function identify(
  ctx: Ctx,
  request: Request,
  role: Role,
  options: { allowKey: boolean; reads?: (user: UserRef) => Statement[]; visitorReads?: Statement[] },
): Promise<{ session: Session | null; rows: Row[][] }> {
  const now = Date.now();
  const found = await credential(ctx, request, role, options.allowKey, now);
  if (!found) {
    return { session: null, rows: options.visitorReads ? await ctx.db.batch(options.visitorReads) : [] };
  }
  const { table, column, extra } = TABLE[role];
  let principal: Statement;
  let ref: UserRef;
  if (found.kind === "session") {
    principal = [
      `SELECT u.id, u.username${extra} FROM sessions s JOIN ${table} u ON u.id = s.${column} WHERE s.id = ? AND s.${column} = ? AND s.expires_at > ?`,
      found.claims.sid, found.claims.sub, now,
    ];
    ref = { sql: `(SELECT ${column} FROM sessions WHERE id = ? AND ${column} = ? AND expires_at > ?)`, params: [found.claims.sid, found.claims.sub, now] };
  } else {
    principal = [`SELECT u.id, u.username${extra} FROM api_keys k JOIN ${table} u ON u.id = k.${column} WHERE k.key_hash = ?`, found.hash];
    ref = { sql: `(SELECT ${column} FROM api_keys WHERE key_hash = ?)`, params: [found.hash] };
  }
  const [who = [], ...rows] = await ctx.db.batch([principal, ...(options.reads?.(ref) ?? [])]);
  const row = who[0];
  if (!row) return { session: null, rows };
  if (found.kind === "session" && request.method !== "GET" && request.method !== "HEAD") requireSameOrigin(ctx, request);
  const user: User = { id: String(row.id), username: String(row.username), props: parseObject(row.props) };
  const viaKey = found.kind === "key";
  const actor: Actor = { role, id: user.id, name: user.username, via: viaKey ? "key" : "session", ip: ipOf(ctx, request) };
  return { session: { role, user, viaKey, actor, rows }, rows };
}

/** The name the audit log gives to a sign-in attempt for an account that does not exist. */
export const UNKNOWN_NAME = "(unknown)";

export interface LoginResult {
  cookie: string;
  user: { id: string; username: string };
}

/**
 * Two database round trips: fetch the user and, once the password checks out,
 * store the session. A refused sign-in is written to the audit log too: with
 * the account's name when there is one, and never with the password.
 */
export async function login(ctx: Ctx, request: Request, role: Role, input: Input): Promise<LoginResult> {
  requireSameOrigin(ctx, request);
  const name = typeof input.username === "string" ? input.username : "";
  const secret = typeof input.password === "string" ? input.password.slice(0, 256) : "";
  const [row] = await ctx.db.query(`SELECT id, username, password_hash FROM ${TABLE[role].table} WHERE username = ? COLLATE NOCASE`, name);
  const valid = await verifyPassword(ctx.secrets.get(SECRET_MASTER), secret, row ? String(row.password_hash) : null);
  // What was typed is only written down when it is the name of an account: people type passwords into the wrong field.
  const actor: Actor = { role, id: row ? String(row.id) : null, name: row ? String(row.username) : UNKNOWN_NAME, via: "password", ip: ipOf(ctx, request) };
  if (!row || !valid) {
    await ctx.db.batch([record(actor, "login.failed", null)]);
    throw new HttpError(401, "Invalid username or password.");
  }
  const now = Date.now();
  const sid = randomId();
  const id = String(row.id);
  const token = await signToken(ctx.secrets.get(SECRET_SIGNING), { sid, sub: id, role, exp: Math.floor((now + SESSION_MS) / 1000) });
  await ctx.db.batch([
    [`INSERT INTO sessions (id, ${TABLE[role].column}, created_at, expires_at) VALUES (?, ?, ?, ?)`, sid, id, now, now + SESSION_MS],
    record(actor, "login", null),
  ]);
  return { cookie: sessionCookie(role, token, SESSION_MS / 1000), user: { id, username: String(row.username) } };
}

/** Deletes the cookie's session, if there is one, and returns the cookie that clears the browser. */
export async function logout(ctx: Ctx, request: Request, role: Role): Promise<string> {
  requireSameOrigin(ctx, request);
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

/** Root password, with a global limit of wrong attempts per hour. */
export async function requireRoot(ctx: Ctx, request: Request): Promise<void> {
  if (request.method !== "GET") requireSameOrigin(ctx, request);
  const hour = Math.floor(Date.now() / HOUR_MS);
  const [row] = await ctx.db.query("SELECT attempts FROM root_attempts WHERE hour = ?", hour);
  if (Number(row?.attempts ?? 0) >= ROOT_ATTEMPTS_PER_HOUR) {
    throw new HttpError(429, "Too many wrong root password attempts. Try again in the next hour.");
  }
  const given = request.headers.get("x-root-password") ?? "";
  if (given !== "" && (await safeEqual(given, ctx.secrets.get(SECRET_ROOT)))) return;
  await ctx.db.batch([
    ["INSERT INTO root_attempts (hour, attempts) VALUES (?, 1) ON CONFLICT (hour) DO UPDATE SET attempts = attempts + 1", hour],
    record(rootActor(ipOf(ctx, request)), "root.denied", null),
  ]);
  throw new HttpError(401, "Wrong root password.");
}

/** Scheduled job: expired sessions, expired access links and old root password attempt counts. The audit log is never trimmed. */
export async function cleanup(ctx: Ctx, time: Date): Promise<void> {
  await ctx.db.batch([
    ["DELETE FROM sessions WHERE expires_at < ?", time.getTime()],
    ["DELETE FROM invites WHERE expires_at < ?", time.getTime()],
    ["DELETE FROM root_attempts WHERE hour < ?", Math.floor(time.getTime() / HOUR_MS) - 24],
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

export interface Source {
  alias: string;
  public: boolean;
  /** Read from the source's source.json; see `origin`. */
  props: Record<string, unknown>;
  render: string[];
  /**
   * Where `props` and `render` come from: "file" is sites/sources/<alias>/source.json,
   * "default" is a source without that file, and "legacy" is a source without
   * it that still has values stored by an older version of the console.
   */
  origin: "file" | "default" | "legacy";
  /** What is wrong with the source.json, if anything. */
  problems: string[];
  created_at: number;
  /** Readers with permission. */
  readers: number;
  /** The subfolder is gone from the repository: the source answers "not found" until it returns or the source is removed. */
  missing: boolean;
}

/**
 * The rendering settings in force for a source row: its source.json when it
 * has one, otherwise what the row still stores from before the file existed.
 */
export async function sourceSettings(ctx: Ctx, alias: string, row: Row): Promise<Pick<Source, "props" | "render" | "origin" | "problems">> {
  const config = await loadSourceConfig(ctx.sites, alias);
  if (config) return { ...config, origin: "file" };
  const render = parseList(row.render, [...DEFAULT_RENDER]);
  const props = parseObject(row.props);
  const untouched = Object.keys(props).length === 0 && JSON.stringify(render) === JSON.stringify(DEFAULT_RENDER);
  return { props, render, origin: untouched ? "default" : "legacy", problems: [] };
}

async function toSource(ctx: Ctx, row: Row, detected: Set<string>): Promise<Source> {
  const alias = String(row.alias);
  const missing = !detected.has(alias);
  const settings = missing ? { props: {}, render: [], origin: "default" as const, problems: [] } : await sourceSettings(ctx, alias, row);
  return {
    alias,
    public: row.public === 1,
    ...settings,
    created_at: Number(row.created_at),
    readers: Number(row.readers ?? 0),
    missing,
  };
}

const SOURCE_COLUMNS =
  "s.alias, s.public, s.props, s.render, s.created_at, (SELECT COUNT(*) FROM permissions p WHERE p.source_alias = s.alias) AS readers";

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

export async function sourcesPage(ctx: Ctx, rows: Row[], filters: URLSearchParams): Promise<Page<Source> & { ignored: string[] }> {
  const detected = new Set(detectedAliases(ctx));
  const page = paged(rows, pageNumber(filters), (row) => toSource(ctx, row, detected));
  return { ...page, items: await Promise.all(page.items), ignored: ignoredFolders(ctx) };
}

export const SOURCE_ALIASES: Statement = ["SELECT alias, public FROM sources ORDER BY alias"];

export function sourceQuery(alias: string): Statement {
  return [`SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.alias = ?`, alias];
}

export async function oneSource(ctx: Ctx, rows: Row[]): Promise<Source> {
  if (!rows[0]) throw new HttpError(404, "Source not found.");
  return toSource(ctx, rows[0], new Set(detectedAliases(ctx)));
}

function sourceFound(alias: string): Found {
  return { from: "sources s WHERE s.alias = ?", params: [alias], id: "s.alias", name: "s.alias" };
}

/** Only the visibility is changed here: `render` and `props` live in the source's source.json. */
export async function updateSource(ctx: Ctx, actor: Actor, alias: string, input: Input): Promise<void> {
  if (input.props !== undefined || input.render !== undefined) {
    throw new HttpError(400, `The props and the rendered extensions are set in sites/${SOURCES_FOLDER}/${alias}/source.json, in the repository. Only "public" can be changed here.`);
  }
  if (input.public === undefined) throw new HttpError(400, "Nothing to change.");
  const [, changed = []] = await ctx.db.batch([
    recordFound(actor, "source.updated", "source", sourceFound(alias), { public: flag(input.public) }),
    ["UPDATE sources SET public = ? WHERE alias = ? RETURNING alias", flag(input.public), alias],
  ]);
  if (changed.length === 0) throw new HttpError(404, "Source not found.");
}

/**
 * Only for a source whose folder is gone: its visibility and its permissions
 * go together. A source whose folder is still published cannot be removed,
 * because it would come back at once, private and without its permissions.
 */
export async function deleteSource(ctx: Ctx, actor: Actor, alias: string): Promise<void> {
  if (detectedAliases(ctx).includes(alias)) {
    throw new HttpError(409, `The folder sites/${SOURCES_FOLDER}/${alias}/ is still published. To remove this source, delete the folder from the repository and publish again; to close it, make it private.`);
  }
  const [, , removed = []] = await ctx.db.batch([
    recordFound(actor, "source.removed", "source", sourceFound(alias)),
    ["DELETE FROM permissions WHERE source_alias = ?", alias],
    ["DELETE FROM sources WHERE alias = ? RETURNING alias", alias],
  ]);
  if (removed.length === 0) throw new HttpError(404, "Source not found.");
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
}

function toAccount(row: Row): Account {
  return {
    id: String(row.id),
    username: String(row.username),
    created_at: Number(row.created_at),
    ...(row.pending === undefined ? {} : { email: typeof row.email === "string" ? row.email : null, pending: row.pending === 1 }),
    ...(row.sources === undefined ? {} : { sources: Number(row.sources) }),
  };
}

/** What a reader has and an administrator has not. */
const READER_COLUMNS = ", u.email, (u.password_hash = '') AS pending";

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
  const extra = role === "reader" ? `${READER_COLUMNS}, (SELECT COUNT(*) FROM permissions p WHERE p.reader_id = u.id) AS sources` : "";
  const order = role === "reader" ? "u.created_at DESC, u.id" : "u.username";
  return [
    `SELECT u.id, u.username, u.created_at${extra} FROM ${TABLE[role].table} u${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
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
  const account: Account = { id: randomId(), username: name, created_at: Date.now() };
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
    [`SELECT u.id, u.username, u.created_at${role === "reader" ? READER_COLUMNS : ""} FROM ${table} u WHERE u.id = ?`, id],
    [`SELECT id, created_at FROM api_keys WHERE ${column} = ? ORDER BY created_at DESC`, id],
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

/**
 * Sessions, keys, access links and permissions are removed explicitly in the
 * same operation: the system does not rely on cascading deletes being enabled
 * in the database.
 */
export async function deleteAccount(ctx: Ctx, actor: Actor, role: Role, id: string): Promise<void> {
  const { table, column } = TABLE[role];
  const statements: Statement[] = [
    recordFound(actor, `${role}.removed`, role, userFound(role, id)),
    [`DELETE FROM sessions WHERE ${column} = ?`, id],
    [`DELETE FROM api_keys WHERE ${column} = ?`, id],
  ];
  if (role === "reader") statements.push(["DELETE FROM permissions WHERE reader_id = ?", id], ["DELETE FROM invites WHERE reader_id = ?", id]);
  statements.push([`DELETE FROM ${table} WHERE id = ? RETURNING id`, id]);
  const results = await ctx.db.batch(statements);
  if ((results.at(-1) ?? []).length === 0) throw new HttpError(404, "User not found.");
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
export async function findInvite(ctx: Ctx, token: string): Promise<{ id: string; username: string; email: string | null; expires_at: number; hash: string }> {
  const hash = await hashInvite(ctx.secrets.get(SECRET_MASTER), token.slice(0, 128));
  const [row] = await ctx.db.query(
    "SELECT u.id, u.username, u.email, i.expires_at FROM invites i JOIN readers u ON u.id = i.reader_id WHERE i.token_hash = ? AND i.expires_at > ?",
    hash, Date.now(),
  );
  if (!row) throw new HttpError(404, INVALID_INVITE);
  return { id: String(row.id), username: String(row.username), email: typeof row.email === "string" ? row.email : null, expires_at: Number(row.expires_at), hash };
}

/**
 * The reader chooses their password. The link stops working in the same
 * operation, every earlier session of the reader ends, and a new one starts:
 * they are signed in.
 */
export async function acceptInvite(ctx: Ctx, request: Request, token: string, input: Input): Promise<LoginResult> {
  requireSameOrigin(ctx, request);
  const reader = await findInvite(ctx, token);
  const hash = await hashPassword(ctx.secrets.get(SECRET_MASTER), password(input.password, [reader.username, reader.email]));
  const tokenHash = reader.hash;
  const now = Date.now();
  const sid = randomId();
  const actor: Actor = { role: "reader", id: reader.id, name: reader.username, via: "link", ip: ipOf(ctx, request) };
  // Every statement checks the link again: of two requests with the same link, only one finds it.
  const valid = "(SELECT reader_id FROM invites WHERE token_hash = ? AND expires_at > ?)";
  const [, changed = []] = await ctx.db.batch([
    recordFound(actor, "reader.password.set", "reader", { from: `readers u WHERE u.id = ${valid}`, params: [tokenHash, now], id: "u.id", name: "u.username" }),
    [`UPDATE readers SET password_hash = ? WHERE id = ${valid} RETURNING id`, hash, tokenHash, now],
    [`DELETE FROM sessions WHERE reader_id = ${valid}`, tokenHash, now],
    [`INSERT INTO sessions (id, reader_id, created_at, expires_at) SELECT ?, reader_id, ?, ? FROM invites WHERE token_hash = ? AND expires_at > ?`, sid, now, now + SESSION_MS, tokenHash, now],
    ["DELETE FROM invites WHERE token_hash = ?", tokenHash],
  ]);
  if (changed.length === 0) throw new HttpError(404, INVALID_INVITE);
  const cookie = await signToken(ctx.secrets.get(SECRET_SIGNING), { sid, sub: reader.id, role: "reader", exp: Math.floor((now + SESSION_MS) / 1000) });
  return { cookie: sessionCookie("reader", cookie, SESSION_MS / 1000), user: { id: reader.id, username: reader.username } };
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

export async function setReaderProps(ctx: Ctx, actor: Actor, readerId: string, value: unknown): Promise<void> {
  const text = propsText(value);
  await ctx.db.batch([
    recordFound(actor, "reader.props.updated", "reader", userFound("reader", readerId), propKeys(text)),
    ["UPDATE readers SET props = ? WHERE id = ?", text, readerId],
  ]);
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface ApiKey {
  id: string;
  created_at: number;
}

function toApiKey(row: Row): ApiKey {
  return { id: String(row.id), created_at: Number(row.created_at) };
}

export function apiKeysQuery(role: Role, user: UserRef): Statement {
  return [`SELECT id, created_at FROM api_keys WHERE ${TABLE[role].column} = ${user.sql} ORDER BY created_at DESC`, ...user.params];
}

export function apiKeys(rows: Row[] | undefined): ApiKey[] {
  return (rows ?? []).map(toApiKey);
}

/** The key itself appears only here, once: the database stores only its hash. */
export async function createApiKey(ctx: Ctx, actor: Actor, role: Role, ownerId: string): Promise<ApiKey & { key: string }> {
  const key = newApiKey(role);
  const created = { id: randomId(), created_at: Date.now() };
  await ctx.db.batch([
    [
      `INSERT INTO api_keys (id, key_hash, ${TABLE[role].column}, created_at) VALUES (?, ?, ?, ?)`,
      created.id, await hashApiKey(ctx.secrets.get(SECRET_MASTER), key), ownerId, created.created_at,
    ],
    record(actor, "api_key.created", { type: "api_key", id: created.id, name: null }, { owner_role: role, owner_id: ownerId }),
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

export function readableSources(rows: Row[] | undefined): { alias: string; public: boolean }[] {
  return (rows ?? []).map((row) => ({ alias: String(row.alias), public: row.public === 1 }));
}
