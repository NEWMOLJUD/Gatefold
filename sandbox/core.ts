// O miolo do Canone: esquema do banco, autenticação e as operações que as
// páginas e a API compartilham. Nenhuma rota é definida aqui.
import type { Database, SqlParam, SqlValue } from "../deps/databases.ts";
import type { Secrets } from "../deps/secrets.ts";
import type { Sites } from "../deps/sites.ts";
import {
  type Claims, type Role, SECRET_MASTER, SECRET_ROOT, SECRET_SIGNING, clearCookie, cookieName, hashApiKey, hashPassword,
  newApiKey, randomId, readCookie, safeEqual, sameOrigin, sessionCookie, signToken, verifyPassword, verifyToken,
} from "./security.ts";

/**
 * Histórico do esquema (seed.md, seção 10). Depois de publicado, nenhuma linha
 * é editada nem removida: toda mudança entra como instrução nova no fim.
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
];

// Decisões para os itens que o seed deixa em aberto (seção 13).
/** Validade de uma sessão de login. */
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
/** Tentativas erradas da senha root aceitas por hora, somando todos os visitantes. */
export const ROOT_ATTEMPTS_PER_HOUR = 5;
/** Tamanho máximo de um JSON de props, em caracteres. */
export const MAX_PROPS = 64 * 1024;
/** Itens por página nas listagens. */
export const PAGE_SIZE = 50;

const HOUR_MS = 60 * 60 * 1000;

export interface Ctx {
  db: Database;
  sites: Sites;
  secrets: Secrets;
}

export type Statement = [sql: string, ...params: SqlParam[]];
export type Row = Record<string, SqlValue>;
type Input = Record<string, unknown>;

/** Erro com mensagem para quem fez a requisição. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Interrompe o atendimento com uma resposta pronta (um redirecionamento, por exemplo). */
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
// Validação
// ---------------------------------------------------------------------------

export const ALIAS = /^[a-z0-9-]+$/;

function username(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._@-]{3,64}$/.test(value)) {
    throw new HttpError(400, "O usuário deve ter de 3 a 64 caracteres: letras, números, ponto, hífen, sublinhado ou @.");
  }
  return value;
}

function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 256) {
    throw new HttpError(400, "A senha deve ter de 8 a 256 caracteres.");
  }
  return value;
}

/** Aceita o objeto (API) ou o texto JSON (formulário) e devolve o texto a gravar. */
export function propsText(value: unknown): string {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value.trim() === "" ? "{}" : value);
    } catch {
      throw new HttpError(400, "Os props não são um JSON válido.");
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, 'Os props devem ser um objeto JSON, por exemplo {"tema": "escuro"}.');
  }
  const text = JSON.stringify(parsed);
  if (text.length > MAX_PROPS) throw new HttpError(400, `Os props passam do tamanho máximo (${MAX_PROPS} caracteres).`);
  return text;
}

/** Aceita a lista (API) ou o texto "html, css" (formulário). */
export function renderText(value: unknown): string {
  const items = typeof value === "string" ? value.split(/[\s,;]+/) : value;
  if (!Array.isArray(items)) throw new HttpError(400, 'As extensões renderizadas devem ser uma lista, por exemplo ["html", "css"].');
  const extensions: string[] = [];
  for (const item of items) {
    if (item === "") continue;
    const extension = typeof item === "string" ? item.replace(/^\./, "").toLowerCase() : "";
    if (!/^[a-z0-9]{1,10}$/.test(extension)) throw new HttpError(400, `Extensão inválida: ${JSON.stringify(item)}. Use nomes como "html" ou "css".`);
    if (!extensions.includes(extension)) extensions.push(extension);
  }
  if (extensions.length > 30) throw new HttpError(400, "Extensões demais: o máximo é 30.");
  return JSON.stringify(extensions);
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

function parseList(text: SqlValue | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(typeof text === "string" ? text : "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function conflict(error: unknown, message: string): never {
  if (error instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(error.message)) throw new HttpError(409, message);
  throw error;
}

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  /** Só leitores têm props. */
  props: Record<string, unknown>;
}

export interface Session {
  role: Role;
  user: User;
  /** Autenticado por chave de API, e não por cookie. */
  viaKey: boolean;
  /** Linhas das leituras pedidas junto com a conferência da sessão. */
  rows: Row[][];
}

/** Como o SQL chega ao identificador do usuário autenticado, antes de o banco responder. */
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
 * Confere quem está chamando e, na mesma ida ao banco, faz as leituras de
 * `reads`. Devolve `null` quando não há sessão nem chave válida; nesse caso as
 * leituras são descartadas. `visitorReads` roda no lugar delas quando o
 * pedido chega sem credencial nenhuma (fontes públicas).
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
  if (found.kind === "session" && request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
    throw new HttpError(403, "Requisição recusada: ela não partiu deste site.");
  }
  const user: User = { id: String(row.id), username: String(row.username), props: parseObject(row.props) };
  return { session: { role, user, viaKey: found.kind === "key", rows }, rows };
}

export interface LoginResult {
  cookie: string;
  user: { id: string; username: string };
}

/** Duas idas ao banco: buscar o usuário e, conferida a senha, gravar a sessão. */
export async function login(ctx: Ctx, role: Role, input: Input): Promise<LoginResult> {
  const name = typeof input.username === "string" ? input.username : "";
  const secret = typeof input.password === "string" ? input.password.slice(0, 256) : "";
  const [row] = await ctx.db.query(`SELECT id, username, password_hash FROM ${TABLE[role].table} WHERE username = ?`, name);
  const valid = await verifyPassword(ctx.secrets.get(SECRET_MASTER), secret, row ? String(row.password_hash) : null);
  if (!row || !valid) throw new HttpError(401, "Usuário ou senha inválidos.");
  const now = Date.now();
  const sid = randomId();
  const id = String(row.id);
  const token = await signToken(ctx.secrets.get(SECRET_SIGNING), { sid, sub: id, role, exp: Math.floor((now + SESSION_MS) / 1000) });
  await ctx.db.query(`INSERT INTO sessions (id, ${TABLE[role].column}, created_at, expires_at) VALUES (?, ?, ?, ?)`, sid, id, now, now + SESSION_MS);
  return { cookie: sessionCookie(role, token, SESSION_MS / 1000), user: { id, username: String(row.username) } };
}

/** Apaga a sessão do cookie, se houver uma, e devolve o cookie que limpa o navegador. */
export async function logout(ctx: Ctx, request: Request, role: Role): Promise<string> {
  if (!sameOrigin(request)) throw new HttpError(403, "Requisição recusada: ela não partiu deste site.");
  const token = readCookie(request, cookieName(role));
  const claims = token ? await verifyToken(ctx.secrets.get(SECRET_SIGNING), token, Date.now()) : null;
  if (claims && claims.role === role) await ctx.db.query("DELETE FROM sessions WHERE id = ?", claims.sid);
  return clearCookie(role);
}

/** Senha root com limite global de tentativas por hora (seção 12, itens 6 e 15). */
export async function requireRoot(ctx: Ctx, request: Request): Promise<void> {
  if (request.method !== "GET" && !sameOrigin(request)) throw new HttpError(403, "Requisição recusada: ela não partiu deste site.");
  const hour = Math.floor(Date.now() / HOUR_MS);
  const [row] = await ctx.db.query("SELECT attempts FROM root_attempts WHERE hour = ?", hour);
  if (Number(row?.attempts ?? 0) >= ROOT_ATTEMPTS_PER_HOUR) {
    throw new HttpError(429, "Muitas tentativas erradas da senha root. Tente de novo na próxima hora.");
  }
  const given = request.headers.get("x-root-password") ?? "";
  if (given !== "" && (await safeEqual(given, ctx.secrets.get(SECRET_ROOT)))) return;
  await ctx.db.query("INSERT INTO root_attempts (hour, attempts) VALUES (?, 1) ON CONFLICT (hour) DO UPDATE SET attempts = attempts + 1", hour);
  throw new HttpError(401, "Senha root incorreta.");
}

/** Tarefa agendada: sessões vencidas e contagens antigas da senha root. */
export async function cleanup(ctx: Ctx, time: Date): Promise<void> {
  await ctx.db.batch([
    ["DELETE FROM sessions WHERE expires_at < ?", time.getTime()],
    ["DELETE FROM root_attempts WHERE hour < ?", Math.floor(time.getTime() / HOUR_MS) - 24],
  ]);
}

// ---------------------------------------------------------------------------
// Listagens
// ---------------------------------------------------------------------------

export interface Page<Item> {
  items: Item[];
  page: number;
  hasNext: boolean;
}

/** "2026-01-31" (dia inteiro, em UTC) ou milissegundos desde 1970. */
function dateFilter(value: string | null, endOfDay: boolean): number | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(start)) throw new HttpError(400, `Data inválida: ${value}.`);
    return endOfDay ? start + 24 * HOUR_MS - 1 : start;
  }
  if (/^\d{1,15}$/.test(value)) return Number(value);
  throw new HttpError(400, `Data inválida: ${value}. Use o formato AAAA-MM-DD.`);
}

function pageNumber(filters: URLSearchParams): number {
  const page = Number(filters.get("page") ?? "1");
  return Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1;
}

/** Filtros comuns, todos sobre colunas com índice: começo do nome e intervalo de criação. */
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
// Fontes
// ---------------------------------------------------------------------------

export interface Source {
  alias: string;
  public: boolean;
  props: Record<string, unknown>;
  render: string[];
  created_at: number;
  /** Leitores com permissão. */
  readers: number;
  /** A subpasta sumiu do repositório: a fonte responde "não encontrado" até ela voltar ou o cadastro ser removido. */
  missing: boolean;
}

function toSource(ctx: Ctx, row: Row): Source {
  const alias = String(row.alias);
  return {
    alias,
    public: row.public === 1,
    props: parseObject(row.props),
    render: parseList(row.render),
    created_at: Number(row.created_at),
    readers: Number(row.readers ?? 0),
    missing: !ctx.sites.folders().includes(alias),
  };
}

const SOURCE_COLUMNS =
  "s.alias, s.public, s.props, s.render, s.created_at, (SELECT COUNT(*) FROM permissions p WHERE p.source_alias = s.alias) AS readers";

/** Filtros: `q` (começo do alias), `created_from`, `created_to`, `min_readers`, `page`. */
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

export function sourcesPage(ctx: Ctx, rows: Row[], filters: URLSearchParams): Page<Source> {
  return paged(rows, pageNumber(filters), (row) => toSource(ctx, row));
}

export const SOURCE_ALIASES: Statement = ["SELECT alias, public FROM sources ORDER BY alias"];

/** Subpastas de `sites/` com nome válido e ainda sem cadastro. */
export function availableFolders(ctx: Ctx, registered: Row[]): string[] {
  const taken = new Set(registered.map((row) => String(row.alias)));
  return ctx.sites.folders().filter((name) => ALIAS.test(name) && !taken.has(name));
}

export function sourceQuery(alias: string): Statement {
  return [`SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.alias = ?`, alias];
}

export function oneSource(ctx: Ctx, rows: Row[]): Source {
  if (!rows[0]) throw new HttpError(404, "Fonte não encontrada.");
  return toSource(ctx, rows[0]);
}

export async function createSource(ctx: Ctx, input: Input): Promise<void> {
  const alias = typeof input.alias === "string" ? input.alias : "";
  if (!ALIAS.test(alias)) throw new HttpError(400, "O alias usa apenas letras minúsculas, números e hífen.");
  if (!ctx.sites.folders().includes(alias)) throw new HttpError(400, `Não existe a subpasta sites/${alias}/ nesta publicação.`);
  try {
    await ctx.db.query(
      "INSERT INTO sources (alias, public, props, render, created_at) VALUES (?, ?, ?, ?, ?)",
      alias, flag(input.public), propsText(input.props ?? {}), renderText(input.render ?? ["html"]), Date.now(),
    );
  } catch (error) {
    conflict(error, "Esta subpasta já está cadastrada como fonte.");
  }
}

export async function updateSource(ctx: Ctx, alias: string, input: Input): Promise<void> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (input.public !== undefined) (sets.push("public = ?"), params.push(flag(input.public)));
  if (input.props !== undefined) (sets.push("props = ?"), params.push(propsText(input.props)));
  if (input.render !== undefined) (sets.push("render = ?"), params.push(renderText(input.render)));
  if (sets.length === 0) throw new HttpError(400, "Nada para alterar.");
  const changed = await ctx.db.query(`UPDATE sources SET ${sets.join(", ")} WHERE alias = ? RETURNING alias`, ...params, alias);
  if (changed.length === 0) throw new HttpError(404, "Fonte não encontrada.");
}

/** A configuração e as permissões saem juntas. Os arquivos continuam na pasta. */
export async function deleteSource(ctx: Ctx, alias: string): Promise<void> {
  const [, removed = []] = await ctx.db.batch([
    ["DELETE FROM permissions WHERE source_alias = ?", alias],
    ["DELETE FROM sources WHERE alias = ? RETURNING alias", alias],
  ]);
  if (removed.length === 0) throw new HttpError(404, "Fonte não encontrada.");
}

// ---------------------------------------------------------------------------
// Usuários (administradores e leitores)
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  username: string;
  created_at: number;
  /** Leitores: fontes privadas liberadas. */
  sources?: number;
}

function toAccount(row: Row): Account {
  return {
    id: String(row.id),
    username: String(row.username),
    created_at: Number(row.created_at),
    ...(row.sources === undefined ? {} : { sources: Number(row.sources) }),
  };
}

/** Filtros: `q` (começo do usuário), `created_from`, `created_to`, `page` e, para leitores, `source`. */
export function listAccountsQuery(role: Role, filters: URLSearchParams): Statement {
  // Administradores não têm índice por data de criação: só o filtro por nome.
  const { where, params } = commonFilters(filters, "u.username", role === "reader" ? "u.created_at" : null);
  const source = role === "reader" ? filters.get("source") : null;
  if (source) {
    where.push("u.id IN (SELECT reader_id FROM permissions WHERE source_alias = ?)");
    params.push(source);
  }
  const count = role === "reader" ? ", (SELECT COUNT(*) FROM permissions p WHERE p.reader_id = u.id) AS sources" : "";
  const order = role === "reader" ? "u.created_at DESC, u.id" : "u.username";
  return [
    `SELECT u.id, u.username, u.created_at${count} FROM ${TABLE[role].table} u${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params, PAGE_SIZE + 1, (pageNumber(filters) - 1) * PAGE_SIZE,
  ];
}

export function accountsPage(rows: Row[], filters: URLSearchParams): Page<Account> {
  return paged(rows, pageNumber(filters), toAccount);
}

export async function createAccount(ctx: Ctx, role: Role, input: Input): Promise<Account> {
  const name = username(input.username);
  const hash = await hashPassword(ctx.secrets.get(SECRET_MASTER), password(input.password));
  const account: Account = { id: randomId(), username: name, created_at: Date.now() };
  try {
    await ctx.db.query(
      `INSERT INTO ${TABLE[role].table} (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
      account.id, name, hash, account.created_at,
    );
  } catch (error) {
    conflict(error, "Já existe um usuário com este nome.");
  }
  return account;
}

export function accountQueries(role: Role, id: string): Statement[] {
  const { table, column } = TABLE[role];
  const queries: Statement[] = [
    [`SELECT id, username, created_at FROM ${table} WHERE id = ?`, id],
    [`SELECT id, created_at FROM api_keys WHERE ${column} = ? ORDER BY created_at DESC`, id],
  ];
  if (role === "reader") {
    queries.push(["SELECT source_alias FROM permissions WHERE reader_id = ? ORDER BY source_alias", id], SOURCE_ALIASES);
  }
  return queries;
}

export interface AccountDetail extends Account {
  api_keys: ApiKey[];
  /** Leitores: aliases liberados. */
  allowed?: string[];
}

export function oneAccount(rows: Row[][]): AccountDetail {
  const row = rows[0]?.[0];
  if (!row) throw new HttpError(404, "Usuário não encontrado.");
  return {
    ...toAccount(row),
    api_keys: (rows[1] ?? []).map(toApiKey),
    ...(rows[2] ? { allowed: rows[2].map((permission) => String(permission.source_alias)) } : {}),
  };
}

/**
 * Altera nome, senha e, para leitores, as fontes liberadas (`sources`: a lista
 * completa de aliases). Tudo em uma operação; trocar a senha apaga as sessões.
 */
export async function updateAccount(ctx: Ctx, role: Role, id: string, input: Input): Promise<void> {
  const { table, column } = TABLE[role];
  const statements: Statement[] = [[`SELECT id FROM ${table} WHERE id = ?`, id]];
  if (input.username !== undefined) statements.push([`UPDATE ${table} SET username = ? WHERE id = ?`, username(input.username), id]);
  if (input.password !== undefined && input.password !== "") {
    const hash = await hashPassword(ctx.secrets.get(SECRET_MASTER), password(input.password));
    statements.push([`UPDATE ${table} SET password_hash = ? WHERE id = ?`, hash, id], [`DELETE FROM sessions WHERE ${column} = ?`, id]);
  }
  if (role === "reader" && input.sources !== undefined) {
    const aliases = Array.isArray(input.sources) ? input.sources : [input.sources];
    if (aliases.length > 1000 || aliases.some((alias) => typeof alias !== "string")) throw new HttpError(400, "Lista de fontes inválida.");
    const now = Date.now();
    statements.push(["DELETE FROM permissions WHERE reader_id = ?", id]);
    for (const alias of new Set(aliases as string[])) {
      // Só entra a permissão se o leitor e a fonte existirem.
      statements.push([
        "INSERT INTO permissions (reader_id, source_alias, created_at) SELECT r.id, s.alias, ? FROM readers r, sources s WHERE r.id = ? AND s.alias = ?",
        now, id, alias,
      ]);
    }
  }
  if (statements.length === 1) throw new HttpError(400, "Nada para alterar.");
  let found: Row[] | undefined;
  try {
    [found] = await ctx.db.batch(statements);
  } catch (error) {
    conflict(error, "Já existe um usuário com este nome.");
  }
  if (!found || found.length === 0) throw new HttpError(404, "Usuário não encontrado.");
}

/**
 * Sessões, chaves e permissões saem na mesma operação, de forma explícita: o
 * sistema não depende de a remoção em cascata estar ligada no banco (seção 12, item 14).
 */
export async function deleteAccount(ctx: Ctx, role: Role, id: string): Promise<void> {
  const { table, column } = TABLE[role];
  const statements: Statement[] = [
    [`DELETE FROM sessions WHERE ${column} = ?`, id],
    [`DELETE FROM api_keys WHERE ${column} = ?`, id],
  ];
  if (role === "reader") statements.push(["DELETE FROM permissions WHERE reader_id = ?", id]);
  statements.push([`DELETE FROM ${table} WHERE id = ? RETURNING id`, id]);
  const results = await ctx.db.batch(statements);
  if ((results.at(-1) ?? []).length === 0) throw new HttpError(404, "Usuário não encontrado.");
}

// ---------------------------------------------------------------------------
// Props da plataforma e do leitor
// ---------------------------------------------------------------------------

export const PLATFORM_PROPS: Statement = ["SELECT props FROM platform WHERE id = 1"];

export function platformProps(rows: Row[] | undefined): Record<string, unknown> {
  return parseObject(rows?.[0]?.props);
}

export async function setPlatformProps(ctx: Ctx, value: unknown): Promise<void> {
  const text = propsText(value);
  await ctx.db.query(
    "INSERT INTO platform (id, props, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET props = excluded.props, updated_at = excluded.updated_at",
    text, Date.now(),
  );
}

export async function setReaderProps(ctx: Ctx, readerId: string, value: unknown): Promise<void> {
  await ctx.db.query("UPDATE readers SET props = ? WHERE id = ?", propsText(value), readerId);
}

// ---------------------------------------------------------------------------
// Chaves de API
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

/** A chave em si aparece só aqui, uma vez: o banco guarda apenas o resumo. */
export async function createApiKey(ctx: Ctx, role: Role, ownerId: string): Promise<ApiKey & { key: string }> {
  const key = newApiKey(role);
  const created = { id: randomId(), created_at: Date.now() };
  await ctx.db.query(
    `INSERT INTO api_keys (id, key_hash, ${TABLE[role].column}, created_at) VALUES (?, ?, ?, ?)`,
    created.id, await hashApiKey(ctx.secrets.get(SECRET_MASTER), key), ownerId, created.created_at,
  );
  return { ...created, key };
}

export async function deleteApiKey(ctx: Ctx, role: Role, ownerId: string, keyId: string): Promise<void> {
  const removed = await ctx.db.query(`DELETE FROM api_keys WHERE id = ? AND ${TABLE[role].column} = ? RETURNING id`, keyId, ownerId);
  if (removed.length === 0) throw new HttpError(404, "Chave não encontrada.");
}

// ---------------------------------------------------------------------------
// Fontes de um leitor
// ---------------------------------------------------------------------------

/** As fontes que o leitor pode abrir: as liberadas para ele e todas as públicas. */
export function readableSourcesQuery(user: UserRef): Statement {
  return [
    `SELECT s.alias, s.public FROM sources s WHERE s.public = 1 OR EXISTS (SELECT 1 FROM permissions p WHERE p.source_alias = s.alias AND p.reader_id = ${user.sql}) ORDER BY s.alias`,
    ...user.params,
  ];
}

export function readableSources(rows: Row[] | undefined): { alias: string; public: boolean }[] {
  return (rows ?? []).map((row) => ({ alias: String(row.alias), public: row.public === 1 }));
}
