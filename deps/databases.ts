/** SQLite databases. No setup: opening an id that does not exist creates it. */
export interface Databases {
  /**
   * `migrations` is the schema history: each statement runs once, in order. To
   * change the schema, append one. Editing or removing one that already ran is
   * an error.
   * @example
   * const db = databases.open("main", [
   *   "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)",
   *   "ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0", // appended later
   * ]);
   */
  open(id: string, migrations: string[]): Database;
}

export interface Database {
  /**
   * Run one statement with `?` parameters; returns its rows.
   * @example
   * const [{ id }] = await db.query<{ id: number }>("INSERT INTO notes (text) VALUES (?) RETURNING id", text);
   * const open = await db.query("SELECT id, text FROM notes WHERE done = ?", false);
   */
  query<Row = Record<string, SqlValue>>(sql: string, ...params: SqlParam[]): Promise<Row[]>;

  /**
   * Run statements as one transaction, all or nothing; returns the rows of
   * each. `BEGIN`/`COMMIT` are not available.
   * @example
   * await db.batch([
   *   ["UPDATE accounts SET balance = balance - ? WHERE id = ?", 10, from],
   *   ["UPDATE accounts SET balance = balance + ? WHERE id = ?", 10, to],
   * ]);
   */
  batch(statements: [sql: string, ...params: SqlParam[]][]): Promise<Record<string, SqlValue>[][]>;
}

/**
 * Limits: integers beyond ±2^53 lose precision (keep such ids as TEXT). No
 * booleans: `true`/`false` are stored as 1/0. BLOBs are `ArrayBuffer`. Every
 * call is a round trip: prefer a JOIN or a `batch` to queries in a loop.
 */
export type SqlValue = string | number | null | ArrayBuffer;

/** `undefined` is rejected: pass `null`. */
export type SqlParam = SqlValue | boolean;
