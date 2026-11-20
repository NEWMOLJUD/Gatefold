// Fixture app for the engine's self-test: touches every capability in deps/.
// It is copied over sandbox/ in a temporary project by run.ts; it is not part
// of your app.
import type { Deps } from "../deps/index.ts";

export default function main({ server, http, databases, files, secrets, cron }: Deps) {
  const db = databases.open("main", [
    "CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, big INTEGER, data BLOB)",
  ]);

  // server
  server.route("GET", "/echo/:name", (request, { name }) => {
    const url = new URL(request.url);
    return Response.json({ name, q: url.searchParams.get("q"), ip: request.headers.get("CF-Connecting-IP"), proto: url.protocol });
  });
  server.route("GET", "/files/*", (_request, params) => Response.json({ rest: params["*"] }));
  server.route("POST", "/boom", () => {
    throw new Error("exploded on purpose");
  });
  server.route("GET", "/not-a-response", (() => "text") as never);
  server.route("GET", "/cookies", () => {
    const response = new Response("ok");
    response.headers.append("Set-Cookie", "a=1");
    response.headers.append("Set-Cookie", "b=2");
    return response;
  });
  server.route("*", "/any", (request) => new Response(request.method));

  // databases
  server.route("POST", "/events", async (request) => {
    const { kind, flag } = (await request.json()) as { kind: string; flag: boolean };
    const [row] = await db.query("INSERT INTO events (kind, big, data) VALUES (?, ?, ?) RETURNING id, kind, big, data", kind, flag, new Uint8Array([1, 2, 3]).buffer);
    return Response.json({ ...row, data: [...new Uint8Array(row!.data as ArrayBuffer)] });
  });
  server.route("GET", "/events", async () => Response.json(await db.query("SELECT id, kind FROM events ORDER BY id")));
  server.route("POST", "/batch", async (request) => {
    const { fail } = (await request.json()) as { fail: boolean };
    await db.batch([
      ["INSERT INTO events (kind) VALUES (?)", "batch-1"],
      [fail ? "INSERT INTO missing_table VALUES (1)" : "INSERT INTO events (kind) VALUES (?)", ...(fail ? [] : ["batch-2"])],
    ]);
    return new Response("ok");
  });
  server.route("GET", "/bigint", async () => Response.json(await db.query("SELECT 9007199254740993 AS big, typeof(9007199254740993) AS type")));
  server.route("POST", "/bad-param", async () => Response.json(await db.query("SELECT ? AS v", undefined as never)));

  // databases: a schema that grows, as an app's does between two deployments
  const first = ["CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"];
  const v1 = databases.open("evolving", first);
  const v2 = databases.open("evolving", [...first, "ALTER TABLE people ADD COLUMN email TEXT NOT NULL DEFAULT 'none'"]);
  const edited = databases.open("evolving", ["CREATE TABLE people (id INTEGER PRIMARY KEY, fullname TEXT)"]);
  server.route("POST", "/people/v1", async () => Response.json(await v1.query("INSERT INTO people (name) VALUES ('Ada') RETURNING *")));
  server.route("GET", "/people/v2", async () => Response.json(await v2.query("SELECT id, name, email FROM people")));
  server.route("GET", "/people/edited", async () => Response.json(await edited.query("SELECT * FROM people")));

  // files
  server.route("PUT", "/blob/*", async (request, params) => {
    const mode = new URL(request.url).searchParams.get("as");
    const body = mode === "stream" ? new Blob([await request.arrayBuffer()]).stream().pipeThrough(new TransformStream()) : await request.arrayBuffer();
    await files.put(params["*"]!, body, request.headers.get("content-type") ?? undefined);
    return new Response("stored", { status: 201 });
  });
  server.route("GET", "/blob/*", async (_request, params) => (await files.get(params["*"]!)) ?? new Response("missing", { status: 404 }));
  server.route("DELETE", "/blob/*", async (_request, params) => {
    await files.delete(params["*"]!);
    return new Response(null, { status: 204 });
  });
  server.route("GET", "/blobs", async (request) => Response.json(await files.list(new URL(request.url).searchParams.get("prefix") ?? undefined)));

  // secrets + http
  server.route("GET", "/secret", () => Response.json({ length: secrets.get("API_KEY").length }));
  server.route("GET", "/weather", async () => {
    const upstream = await http.fetch("https://weather.example/today?city=Lisbon", {
      method: "POST",
      headers: { authorization: `Bearer ${secrets.get("API_KEY")}` },
      body: JSON.stringify({ units: "c" }),
    });
    return Response.json({ status: upstream.status, body: await upstream.json(), via: upstream.headers.get("x-served-by") });
  });

  // cron
  cron.schedule("0 3 * * *", async (time) => {
    await db.query("INSERT INTO events (kind) VALUES (?)", `nightly ${time.toISOString()}`);
  });
  cron.schedule("*/15 * * * 1-5", async () => {
    await db.query("INSERT INTO events (kind) VALUES ('weekday-quarter')");
  });
  cron.schedule("30 12 1 1 *", () => {
    throw new Error("new year job failed");
  });
}
