import type { Tests } from "../deps/testing.ts";

export default function ({ test, assert }: Tests) {
  test("server: params, query, wildcard, static files, 404, 405, HEAD, any-method", async (app) => {
    const echo = (await (await app.fetch("/echo/Ana%20Maria?q=1")).json()) as { name: string; q: string; ip: string };
    assert.equal({ name: echo.name, q: echo.q }, { name: "Ana Maria", q: "1" });
    assert(echo.ip, "the client address header is present");
    assert.equal(await (await app.fetch("/files/a/b/c.txt")).json(), { rest: "a/b/c.txt" });
    assert((await (await app.fetch("/")).text()).includes("fixture page"));
    assert.equal((await app.fetch("/nope")).status, 404);
    const wrong = await app.fetch("/boom");
    assert.equal([wrong.status, wrong.headers.get("allow")], [405, "POST"]);
    const head = await app.fetch("/echo/x", { method: "HEAD" });
    assert.equal([head.status, await head.text()], [200, ""]);
    assert.equal(await (await app.fetch("/any", { method: "PATCH" })).text(), "PATCH");
    assert.equal((await app.fetch("/cookies")).headers.getSetCookie(), ["a=1", "b=2"]);
  });

  test("server: a thrown error and a non-Response become a 500 with the reason", async (app) => {
    const boom = await app.fetch("/boom", { method: "POST" });
    assert.equal([boom.status, await boom.json()], [500, { error: "exploded on purpose" }]);
    const wrong = await app.fetch("/not-a-response");
    assert.equal(wrong.status, 500);
    assert(((await wrong.json()) as { error: string }).error.includes("instead of a Response"));
  });

  test("databases: insert, booleans, blobs, RETURNING and a fresh database per test", async (app) => {
    const created = await app.fetch("/events", { method: "POST", body: JSON.stringify({ kind: "signup", flag: true }) });
    assert.equal(await created.json(), { id: 1, kind: "signup", big: 1, data: [1, 2, 3] });
    assert.equal(await (await app.fetch("/events")).json(), [{ id: 1, kind: "signup" }]);
  });

  test("databases: batch is all or nothing", async (app) => {
    assert.equal((await app.fetch("/batch", { method: "POST", body: JSON.stringify({ fail: true }) })).status, 500);
    assert.equal(await (await app.fetch("/events")).json(), []);
    assert.equal((await app.fetch("/batch", { method: "POST", body: JSON.stringify({ fail: false }) })).status, 200);
    assert.equal(((await (await app.fetch("/events")).json()) as unknown[]).length, 2);
  });

  test("databases: documented limits (integer precision, undefined parameter)", async (app) => {
    const [row] = (await (await app.fetch("/bigint")).json()) as { big: number; type: string }[];
    assert.equal([row!.big, row!.type], [9007199254740992, "integer"]);
    const bad = await app.fetch("/bad-param", { method: "POST" });
    assert(((await bad.json()) as { error: string }).error.includes("undefined (pass null instead)"));
  });

  test("databases: a second migration is applied to a database that already has data", async (app) => {
    assert.equal(await (await app.fetch("/people/v1", { method: "POST" })).json(), [{ id: 1, name: "Ada" }]);
    assert.equal(await (await app.fetch("/people/v2")).json(), [{ id: 1, name: "Ada", email: "none" }]);
    // The older code keeps working against the newer schema.
    assert.equal((await app.fetch("/people/v1", { method: "POST" })).status, 200);
    const edited = await app.fetch("/people/edited");
    assert.equal(edited.status, 500);
    assert(((await edited.json()) as { error: string }).error.includes("migration 1 was changed after it had already run"));
  });

  test("files: round trip, metadata, unknown-length stream, list, delete", async (app) => {
    assert.equal((await app.fetch("/blob/docs/a.txt", { method: "PUT", body: "hello files", headers: { "content-type": "text/plain" } })).status, 201);
    assert.equal((await app.fetch("/blob/docs/b.bin?as=stream", { method: "PUT", body: new Uint8Array([9, 8, 7]) })).status, 201);
    const a = await app.fetch("/blob/docs/a.txt");
    assert.equal([a.status, a.headers.get("content-type"), await a.text()], [200, "text/plain", "hello files"]);
    assert(a.headers.get("etag"), "an ETag is set");
    assert.equal([...new Uint8Array(await (await app.fetch("/blob/docs/b.bin")).arrayBuffer())], [9, 8, 7]);
    const listed = (await (await app.fetch("/blobs?prefix=docs/")).json()) as { key: string; size: number; uploaded: string }[];
    assert.equal(listed.map((file) => [file.key, file.size]), [["docs/a.txt", 11], ["docs/b.bin", 3]]);
    assert(!Number.isNaN(Date.parse(listed[0]!.uploaded)));
    assert.equal((await app.fetch("/blob/docs/a.txt", { method: "DELETE" })).status, 204);
    assert.equal((await app.fetch("/blob/docs/a.txt")).status, 404);
    assert.equal(((await (await app.fetch("/blobs")).json()) as unknown[]).length, 1);
  });

  test("files: every test starts with empty storage", async (app) => {
    assert.equal(await (await app.fetch("/blobs")).json(), []);
  });

  test("secrets: a missing secret explains how to set it", async (app) => {
    const response = await app.fetch("/secret");
    assert.equal(response.status, 500);
    assert(((await response.json()) as { error: string }).error.includes('Secret "API_KEY" is not set in this test'));
  });

  test("secrets: values come from the test options", { secrets: { API_KEY: "sk-test-123" } }, async (app) => {
    assert.equal(await (await app.fetch("/secret")).json(), { length: 11 });
  });

  const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  test(
    "http: outbound calls are answered by the test's http function",
    {
      secrets: { API_KEY: "sk-test-123" },
      http: async (request) => {
        seen.push({ url: request.url, method: request.method, auth: request.headers.get("authorization"), body: await request.json() });
        return Response.json({ temp: 21 }, { status: 203, headers: { "x-served-by": "mock" } });
      },
    },
    async (app) => {
      assert.equal(await (await app.fetch("/weather")).json(), { status: 203, body: { temp: 21 }, via: "mock" });
      assert.equal(seen, [{ url: "https://weather.example/today?city=Lisbon", method: "POST", auth: "Bearer sk-test-123", body: { units: "c" } }]);
    },
  );

  test("http: without an http function a call fails instead of reaching the network", { secrets: { API_KEY: "x" } }, async (app) => {
    const response = await app.fetch("/weather");
    assert.equal(response.status, 500);
    assert(((await response.json()) as { error: string }).error.includes("tests never reach the network"));
  });

  test("cron: jobs run when their expression matches, and only then", async (app) => {
    await app.runCron("2026-01-05T03:00:00Z"); // a Monday, 03:00: "0 3 * * *" and "*/15 * * * 1-5"
    assert.equal(((await (await app.fetch("/events")).json()) as { kind: string }[]).map((event) => event.kind), ["nightly 2026-01-05T03:00:00.000Z", "weekday-quarter"]);
    await app.runCron("2026-01-04T04:20:00Z"); // a Sunday, 04:20: nothing is due
    assert.equal(((await (await app.fetch("/events")).json()) as unknown[]).length, 2);
    await app.runCron(new Date("2026-01-06T10:45:30Z")); // a Tuesday, 10:45
    assert.equal(((await (await app.fetch("/events")).json()) as unknown[]).length, 3);
  });

  test("cron: a failing job rejects runCron", async (app) => {
    let message = "";
    await app.runCron("2026-01-01T12:30:00Z").catch((error: Error) => (message = error.message));
    assert(message.includes("new year job failed"), message);
  });
}
