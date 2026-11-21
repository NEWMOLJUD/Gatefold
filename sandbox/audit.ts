// The audit log: one row for every change made to the database, written in
// the same transaction as the change itself. If the change is undone, so is
// its row; if the row cannot be written, the change does not happen.
//
// Rows are only ever added. Nothing in the app updates or deletes them, and
// they never hold a password, an API key or an access link.
import type { SqlParam, SqlValue } from "../deps/databases.ts";

type Statement = [sql: string, ...params: SqlParam[]];

/** Who made a change. */
export interface Actor {
  /** "system" is the app itself (a new folder detected); "root" is whoever holds the root password. */
  role: "admin" | "reader" | "root" | "system";
  id: string | null;
  name: string;
  /** How they proved who they are. */
  via: "session" | "key" | "password" | "root-password" | "link" | "system";
  ip: string | null;
}

/** Every action the log can hold, with the text the console shows for it. */
export const ACTIONS = {
  "login": "Signed in",
  "login.failed": "Sign-in refused",
  "logout": "Signed out",
  "root.denied": "Root password refused",
  "admin.created": "Administrator created",
  "admin.updated": "Administrator changed",
  "admin.removed": "Administrator removed",
  "reader.created": "Reader created",
  "reader.updated": "Reader changed",
  "reader.removed": "Reader removed",
  "reader.invite.created": "Access link generated",
  "reader.invite.revoked": "Access link revoked",
  "reader.password.set": "Password created through a link",
  "reader.props.updated": "Reader preferences changed",
  "source.detected": "Source detected",
  "source.updated": "Source visibility changed",
  "source.removed": "Source removed",
  "platform.props.updated": "Platform props changed",
  "api_key.created": "API key generated",
  "api_key.revoked": "API key revoked",
} as const;

export type Action = keyof typeof ACTIONS;

export type TargetType = "admin" | "reader" | "source" | "platform" | "api_key";

export const SYSTEM: Actor = { role: "system", id: null, name: "system", via: "system", ip: null };

/** The visitor's address, when the platform says it (Cloudflare does; a plain Linux server does not). */
export function clientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip")?.slice(0, 64) ?? null;
}

export function rootActor(request: Request): Actor {
  return { role: "root", id: null, name: "root", via: "root-password", ip: clientIp(request) };
}

const COLUMNS = "(at, actor_role, actor_id, actor_name, via, ip, action, target_type, target_id, target_name, details)";

function head(actor: Actor, action: Action): SqlParam[] {
  return [Date.now(), actor.role, actor.id, actor.name.slice(0, 64), actor.via, actor.ip, action];
}

/** A log row for a change that is known to happen (a creation, for example). */
export function record(
  actor: Actor,
  action: Action,
  target: { type: TargetType; id: string | null; name: string | null } | null,
  details: Record<string, unknown> = {},
): Statement {
  return [
    `INSERT INTO audit_log ${COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...head(actor, action), target?.type ?? null, target?.id ?? null, target?.name ?? null, JSON.stringify(details),
  ];
}

/**
 * Where the target of a change is, in SQL: the rows of `from` are the ones
 * being changed, and `id` and `name` are expressions over them.
 */
export interface Found {
  from: string;
  params: SqlParam[];
  id: string;
  name: string;
}

/**
 * A log row for each target that exists. It goes *before* the change in the
 * same batch: a change that finds nothing leaves no row, and the name of what
 * is being removed is still there to be written down.
 */
export function recordFound(actor: Actor, action: Action, type: TargetType, found: Found, details: Record<string, unknown> = {}): Statement {
  return [
    `INSERT INTO audit_log ${COLUMNS} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ${found.id}, ${found.name}, ? FROM ${found.from}`,
    ...head(actor, action), type, JSON.stringify(details), ...found.params,
  ];
}

/**
 * A log row whose actor is read from the database, for when the request only
 * carries a reference to them (the session being closed, for example). `found`
 * says where they are; nothing found, no row.
 */
export function recordAs(who: Pick<Actor, "role" | "via" | "ip">, action: Action, found: Found): Statement {
  return [
    `INSERT INTO audit_log (at, actor_role, actor_id, actor_name, via, ip, action) SELECT ?, ?, ${found.id}, ${found.name}, ?, ?, ? FROM ${found.from}`,
    Date.now(), who.role, who.via, who.ip, action, ...found.params,
  ];
}

export interface AuditEntry {
  id: number;
  at: number;
  actor: { role: string; id: string | null; name: string; via: string; ip: string | null };
  action: string;
  target: { type: string; id: string | null; name: string | null } | null;
  details: Record<string, unknown>;
}

const text = (value: SqlValue | undefined): string | null => (typeof value === "string" ? value : null);

export function toAuditEntry(row: Record<string, SqlValue>): AuditEntry {
  let details: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text(row.details) ?? "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
  } catch {
    // A row that cannot be read is still listed, without details.
  }
  return {
    id: Number(row.id),
    at: Number(row.at),
    actor: { role: String(row.actor_role), id: text(row.actor_id), name: String(row.actor_name), via: String(row.via), ip: text(row.ip) },
    action: String(row.action),
    target: row.target_type === null ? null : { type: String(row.target_type), id: text(row.target_id), name: text(row.target_name) },
    details,
  };
}
