// Counting attempts: how many times something was tried, per key, in a window
// of time. The platform gives the app no rate limiter, so the count lives in
// the database (`login_attempts`), where every instance of the app sees it.
//
// A key says what is being counted and for whom ("this account from this
// address"). It never holds what was typed: see `hashAttempt` in security.ts.
import type { SqlParam, SqlValue } from "../deps/databases.ts";

type Statement = [sql: string, ...params: SqlParam[]];

/** At most `max` attempts on `key` in a window. */
export interface Limit {
  key: string;
  max: number;
}

/** The window of sign-in attempts. */
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function keysOf(limits: Limit[]): string {
  return JSON.stringify(limits.map((limit) => limit.key));
}

/**
 * Counts one more attempt on each key and returns what each count became. A
 * key whose window has passed starts again from one. Counting before the
 * attempt is judged is what makes a burst of parallel requests count in full.
 */
export function countAttempts(limits: Limit[], now: number, windowMs = ATTEMPT_WINDOW_MS): Statement {
  return [
    "INSERT INTO login_attempts (key, started_at, attempts) SELECT value, ?, 1 FROM json_each(?) WHERE true " +
      "ON CONFLICT (key) DO UPDATE SET attempts = CASE WHEN ? - started_at >= ? THEN 1 ELSE attempts + 1 END, " +
      "started_at = CASE WHEN ? - started_at >= ? THEN ? ELSE started_at END RETURNING key, attempts",
    now, keysOf(limits), now, windowMs, now, windowMs, now,
  ];
}

/** The counts as they are, without adding to them. */
export function readAttempts(limits: Limit[], now: number, windowMs = ATTEMPT_WINDOW_MS): Statement {
  return ["SELECT key, attempts FROM login_attempts WHERE key IN (SELECT value FROM json_each(?)) AND ? - started_at < ?", keysOf(limits), now, windowMs];
}

/** Takes back the attempt that `countAttempts` counted: it turned out to be a good one. */
export function uncountAttempts(limits: Limit[]): Statement {
  return ["UPDATE login_attempts SET attempts = MAX(attempts - 1, 0) WHERE key IN (SELECT value FROM json_each(?))", keysOf(limits)];
}

/** Forgets a key: whoever it counted proved who they are. */
export function forgetAttempts(key: string): Statement {
  return ["DELETE FROM login_attempts WHERE key = ?", key];
}

/**
 * Is any key past its limit? `counted` says the rows come from `countAttempts`
 * (this attempt is already in them) rather than from `readAttempts`.
 */
export function overLimit(rows: Record<string, SqlValue>[], limits: Limit[], counted: boolean): boolean {
  const attempts = new Map(rows.map((row) => [String(row.key), Number(row.attempts)]));
  return limits.some((limit) => (attempts.get(limit.key) ?? 0) > (counted ? limit.max : limit.max - 1));
}

/** Scheduled job: counts whose window is long past. */
export function cleanupAttempts(now: number): Statement {
  return ["DELETE FROM login_attempts WHERE started_at < ?", now - 24 * 60 * 60 * 1000];
}
