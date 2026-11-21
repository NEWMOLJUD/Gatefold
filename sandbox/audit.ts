// The audit log: one row for every change made to the database, written in
// the same transaction as the change itself. If the change is undone, so is
// its row; if the row cannot be written, the change does not happen.
//
// Rows are only ever added. Nothing an administrator can reach updates or
// deletes them, and they never hold a password, an API key or an access link.
// The one thing that removes rows is time: the scheduled job deletes those
// older than the retention period, which only root sets, and leaves a row
// saying how many it removed.
import type { SqlParam, SqlValue } from "../deps/databases.ts";

type Statement = [sql: string, ...params: SqlParam[]];

/** Who made a change. */
export interface Actor {
  /**
   * "system" is the app itself (a new folder detected); "root" is whoever
   * holds the root password; "visitor" is someone who is not signed in.
   */
  role: "admin" | "reader" | "root" | "system" | "visitor";
  id: string | null;
  name: string;
  /** How they proved who they are. */
  via: "session" | "key" | "password" | "root-password" | "link" | "system" | "none";
  ip: string | null;
}

/** Every action the log can hold, with the text the console shows for it. */
export const ACTIONS = {
  "login": "Signed in",
  "login.failed": "Sign-in refused",
  "login.blocked": "Sign-in blocked: too many attempts",
  "password.changed": "Own password changed",
  "admin.suspended": "Administrator suspended",
  "admin.reactivated": "Administrator reactivated",
  "reader.suspended": "Reader suspended",
  "reader.reactivated": "Reader reactivated",
  "logout": "Signed out",
  "root.denied": "Root password refused",
  "root.blocked": "Root password blocked: too many attempts",
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
  "source.read": "Private source opened",
  "source.denied": "Source refused: no permission",
  "invite.invalid": "Invalid access link tried",
  "request.refused": "Request from another site refused",
  "audit.exported": "Audit log exported",
  "audit.purged": "Old audit entries removed",
  "settings.updated": "Policy changed",
} as const;

export type Action = keyof typeof ACTIONS;

export type TargetType = "admin" | "reader" | "source" | "platform" | "api_key";

export const SYSTEM: Actor = { role: "system", id: null, name: "system", via: "system", ip: null };

/** Someone who is not signed in. */
export function visitor(ip: string | null, via: Actor["via"] = "none"): Actor {
  return { role: "visitor", id: null, name: "visitor", via, ip };
}

/** The hour a moment belongs to: what "once an hour" is counted by. */
export function hourOf(milliseconds: number): number {
  return Math.floor(milliseconds / 3_600_000);
}

/** Whoever holds the root password. `ip` is the visitor's address: see `clientIp` in config.ts. */
export function rootActor(ip: string | null): Actor {
  return { role: "root", id: null, name: "root", via: "root-password", ip };
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
 * A log row for something that repeats (a refused request, an invalid link):
 * of all the rows with the same `key`, only the first is kept. Put the hour in
 * the key and the event is written once an hour, however often it happens.
 */
export function recordOnce(actor: Actor, action: Action, key: string, details: Record<string, unknown> = {}): Statement {
  return [
    "INSERT OR IGNORE INTO audit_log (at, actor_role, actor_id, actor_name, via, ip, action, details, dedupe) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ...head(actor, action), JSON.stringify(details), key.slice(0, 200),
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
