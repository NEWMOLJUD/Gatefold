// deps.databases on SQLite-backed Durable Objects: one object per database id.
// Nothing has to be created anywhere: asking for an id that does not exist
// makes it. Locally Miniflare keeps each one as a .sqlite file on disk.
import { DurableObject } from "cloudflare:workers";
import type { Database as DatabaseHandle, SqlParam, SqlValue } from "../../deps/databases.ts";
import type { Env } from "./env.ts";

type Row = Record<string, SqlValue>;
type Statement = [sql: string, ...params: SqlValue[]];

const NEEDS_MIGRATIONS = "redoma:needs-migrations";

/** The Durable Object behind one database. */
export class Database extends DurableObject<Env> {
  /** Normalized text of the migrations already applied, in order. */
  #applied: string[] | undefined;

  /**
   * Apply pending migrations, then run the statements.
   * `migrations` is the full list, or just its length once the caller knows
   * this object has seen the list (saves resending it on every query).
   */
  run(id: string, migrations: string[] | number, statements: Statement[], atomic: boolean): Row[][] {
    const sql = this.ctx.storage.sql;
    if (!this.#applied) {
      sql.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, sql TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      this.#applied = sql.exec<{ sql: string }>("SELECT sql FROM _migrations ORDER BY id").toArray().map((row) => row.sql);
    }
    if (typeof migrations === "number") {
      if (this.#applied.length < migrations) throw new Error(NEEDS_MIGRATIONS);
    } else {
      this.#migrate(id, migrations);
    }
    const execute = () => statements.map(([text, ...params]) => sql.exec<Row>(text, ...params).toArray());
    return atomic ? this.ctx.storage.transactionSync(execute) : execute();
  }

  #migrate(id: string, migrations: string[]): void {
    const applied = this.#applied!;
    for (let i = 0; i < applied.length; i++) {
      if (i < migrations.length && normalize(migrations[i]!) === applied[i]) continue;
      throw new Error(
        `Database "${id}": migration ${i + 1} was ${i < migrations.length ? "changed" : "removed"} after it had already run. ` +
          `Migrations are append-only: put it back exactly as it was (${JSON.stringify(preview(applied[i]!))}) and add a new statement at the end of the list for your change.`,
      );
    }
    for (let i = applied.length; i < migrations.length; i++) {
      const statement = migrations[i]!;
      try {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(statement);
          this.ctx.storage.sql.exec("INSERT INTO _migrations (id, sql, applied_at) VALUES (?, ?, ?)", i + 1, normalize(statement), Date.now());
        });
      } catch (error) {
        throw new Error(`Database "${id}": migration ${i + 1} failed: ${message(error)}. Statement: ${JSON.stringify(preview(statement))}`);
      }
      applied.push(normalize(statement));
    }
  }
}

/** The handle `deps.databases.open` returns. No I/O happens until the first query. */
export function openDatabase(env: Env, scope: string, id: string, migrations: string[]): DatabaseHandle {
  if (typeof id !== "string" || id === "" || id.length > 100) {
    throw new TypeError(`databases.open: the id must be a non-empty string of at most 100 characters (got ${JSON.stringify(id)}).`);
  }
  if (!Array.isArray(migrations) || migrations.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`databases.open("${id}"): migrations must be an array of SQL strings.`);
  }
  const list = [...migrations];
  let known = false;

  const call = async (statements: Statement[], atomic: boolean): Promise<Row[][]> => {
    const stub = env.DB.get(env.DB.idFromName(scope + id));
    try {
      const rows = await stub.run(id, known ? list.length : list, statements, atomic);
      known = true;
      return rows as Row[][];
    } catch (error) {
      if (known && message(error).includes(NEEDS_MIGRATIONS)) {
        known = false;
        return call(statements, atomic);
      }
      throw new Error(message(error));
    }
  };

  return {
    async query<R = Row>(sql: string, ...params: SqlParam[]): Promise<R[]> {
      const [rows] = await call([statement("query", sql, params)], false);
      return rows as R[];
    },
    batch(statements: [sql: string, ...params: SqlParam[]][]): Promise<Row[][]> {
      if (!Array.isArray(statements) || statements.some((item) => !Array.isArray(item))) {
        throw new TypeError('db.batch: pass an array of [sql, ...params] entries, for example [["DELETE FROM notes WHERE id = ?", 1]].');
      }
      return call(statements.map(([sql, ...params]) => statement("batch", sql, params)), true);
    },
  };
}

function statement(method: string, sql: string, params: SqlParam[]): Statement {
  if (typeof sql !== "string" || sql.trim() === "") throw new TypeError(`db.${method}: the SQL must be a non-empty string.`);
  const values = params.map((value, index): SqlValue => {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value === null || typeof value === "string" || value instanceof ArrayBuffer) return value;
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    }
    const got = value === undefined ? "undefined (pass null instead)" : typeof value === "number" ? "NaN" : typeof value;
    throw new TypeError(`db.${method}: parameter ${index + 1} of ${JSON.stringify(preview(sql))} is ${got}. Use a string, number, boolean, null or ArrayBuffer.`);
  });
  return [sql, ...values];
}

/** Reformatting a migration is not a change: compare with whitespace collapsed. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function preview(sql: string): string {
  const flat = normalize(sql);
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
