import type { Deps } from "../deps/index.ts";

// The example app: a link shortener that never outgrows its database, because
// its links are spread over billions of possible small ones.
//
// A short code looks like "k3x9ab7x": seven random characters and one check
// character. The first six name the database that keeps it ("links-k3x9ab"),
// so opening a link is always one query to one small database, however many
// links exist. The link databases share nothing: no index, no list of them.
//
// A database is created by the first query that names it, even a read. The
// check character keeps a mistyped or guessed address from creating one: a
// code whose last character does not match is refused before any database is
// opened.
//
// One thing is shared, on purpose: a single database, "redirect-count", counts
// the redirects and the databases that keep links, so the page can show real
// numbers. Every visit writes to it, which makes it the one part that does not
// scale sideways. Nothing depends on it: if a count cannot be saved, the link
// is still made or opened, and the number falls behind.

const LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

// The size of the whole system is decided by these two numbers. Changing them
// moves where links are kept: links made before the change stop opening.
const RANDOM_LETTERS = 7; // drawn for every link; the check character follows them
const DATABASE_LETTERS = 6; // how many of them name the database

const POSSIBLE_LINKS = LETTERS.length ** RANDOM_LETTERS; // 78,364,164,096
const POSSIBLE_DATABASES = LETTERS.length ** DATABASE_LETTERS; // 2,176,782,336
const LINKS_PER_HOUR = 20;

export default function main({ server, databases }: Deps) {
  /** Opens a link database by name. Opening one that does not exist creates it. */
  function linksIn(name: string) {
    return databases.open(name, [
      "CREATE TABLE links (code TEXT PRIMARY KEY, url TEXT NOT NULL, created_at INTEGER NOT NULL)",
    ]);
  }

  /** The one shared database. Each of its tables holds a single row: a total. */
  function counts() {
    return databases.open("redirect-count", [
      "CREATE TABLE redirects (id INTEGER PRIMARY KEY CHECK (id = 1), total INTEGER NOT NULL)",
      "CREATE TABLE databases (id INTEGER PRIMARY KEY CHECK (id = 1), total INTEGER NOT NULL)",
    ]);
  }

  /** Adds one to a total. Counting never costs a visitor their link: a failure is only logged. */
  async function count(table: "redirects" | "databases"): Promise<void> {
    await counts()
      .query(`INSERT INTO ${table} (id, total) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET total = total + 1`)
      .catch((error) => console.error(`Could not count one of the ${table}:`, error));
  }

  /** Counts one more link for this visitor and returns their total this hour. */
  async function countLink(visitor: string): Promise<number> {
    const db = databases.open(`visitor-${visitor}`, [
      "CREATE TABLE hours (hour INTEGER PRIMARY KEY, links INTEGER NOT NULL)",
    ]);
    const hour = Math.floor(Date.now() / 3_600_000);
    const [row] = await db.query<{ links: number }>(
      "INSERT INTO hours (hour, links) VALUES (?, 1) ON CONFLICT (hour) DO UPDATE SET links = links + 1 RETURNING links",
      hour,
    );
    return row.links;
  }

  server.route("GET", "/api/stats", async () => {
    const [totals] = await counts().query<{ redirects: number | null; databases: number | null }>(
      "SELECT (SELECT total FROM redirects WHERE id = 1) AS redirects, (SELECT total FROM databases WHERE id = 1) AS databases",
    );
    return Response.json(
      {
        redirects: totals.redirects ?? 0,
        databases: totals.databases ?? 0,
        possibleDatabases: POSSIBLE_DATABASES,
        possibleLinks: POSSIBLE_LINKS,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });

  server.route("POST", "/api/links", async (request) => {
    const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
    const url = webAddress(body?.url);
    if (!url) return Response.json({ error: "Enter a web address that starts with http:// or https://." }, { status: 400 });

    const visitor = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if ((await countLink(visitor)) > LINKS_PER_HOUR) {
      return Response.json({ error: "That is a lot of links. Try again in an hour." }, { status: 429 });
    }

    // Two links may draw the same code. The database refuses the second one
    // (the code is its primary key), and we simply draw again.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
      const database = `links-${code.slice(0, DATABASE_LETTERS)}`;
      const [saved, [{ links }]] = await linksIn(database).batch([
        ["INSERT OR IGNORE INTO links (code, url, created_at) VALUES (?, ?, ?) RETURNING code", code, url, Date.now()],
        ["SELECT COUNT(*) AS links FROM links"],
      ]);
      if (saved.length === 0) continue;

      if (links === 1) await count("databases"); // its first link: this database is now in use
      return Response.json({ code, url, database }, { status: 201 });
    }
    return Response.json({ error: "Could not find a free code. Try again." }, { status: 503 });
  });

  // Files in public/ win over this route, so "/" is still the page.
  server.route("GET", "/:code", async (_request, { code }) => {
    const database = databaseOf(code);
    if (!database) return new Response("Link not found.", { status: 404 });

    const [link] = await linksIn(database).query<{ url: string }>("SELECT url FROM links WHERE code = ?", code);
    if (!link) return new Response("Link not found.", { status: 404 });

    await count("redirects");
    return Response.redirect(link.url, 302);
  });
}

/** Seven random characters and their check character: 78 billion possible codes. */
function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LETTERS));
  const letters = Array.from(bytes, (byte) => LETTERS[byte % LETTERS.length]).join("");
  return letters + checkLetter(letters);
}

/** The character that must end a code: the positions of its other characters, added up. */
function checkLetter(letters: string): string {
  let sum = 0;
  for (const letter of letters) sum += LETTERS.indexOf(letter);
  return LETTERS[sum % LETTERS.length];
}

/** The name of the database that keeps this code, or null if this cannot be a code. */
function databaseOf(code: string): string | null {
  if (![...code].every((letter) => LETTERS.includes(letter))) return null;
  if (code.length === RANDOM_LETTERS + 1) {
    return code.endsWith(checkLetter(code.slice(0, -1))) ? `links-${code.slice(0, DATABASE_LETTERS)}` : null;
  }
  // Links made when codes were six characters long are kept by their first two.
  return code.length === 6 ? `links-${code.slice(0, 2)}` : null;
}

/** The address, tidied up, if it is an http(s) one a browser can open. Otherwise null. */
function webAddress(text: unknown): string | null {
  if (typeof text !== "string" || text.length > 2000 || !URL.canParse(text)) return null;
  const url = new URL(text);
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}
