import type { Tests } from "../deps/testing.ts";

type App = { fetch: (path: string, init?: RequestInit) => Promise<Response> };
type Stats = { redirects: number; databases: number; possibleDatabases: number; possibleLinks: number };

export default function ({ test, assert }: Tests) {
  const shorten = (app: App, url: unknown) => app.fetch("/api/links", { method: "POST", body: JSON.stringify({ url }) });
  const stats = async (app: App) => (await (await app.fetch("/api/stats")).json()) as Stats;

  test("shortens a link and redirects to it", async (app) => {
    const created = await shorten(app, "https://example.com/a/long/path?x=1");
    assert.equal(created.status, 201);
    const link = (await created.json()) as { code: string; url: string; database: string };
    assert(/^[a-z0-9]{8}$/.test(link.code), "the code is eight letters or digits");
    assert.equal(link.url, "https://example.com/a/long/path?x=1");
    assert.equal(link.database, `links-${link.code.slice(0, 6)}`);

    const opened = await app.fetch(`/${link.code}`);
    assert.equal(opened.status, 302);
    assert.equal(opened.headers.get("Location"), "https://example.com/a/long/path?x=1");
  });

  test("an unknown code is a 404", async (app) => {
    assert.equal((await app.fetch("/abc123")).status, 404);
    assert.equal((await app.fetch("/not-a-code")).status, 404);
    assert.equal((await app.fetch("/download")).status, 404);
  });

  test("a code with the wrong last character is refused", async (app) => {
    const { code } = (await (await shorten(app, "https://example.com/")).json()) as { code: string };
    const mistyped = code.slice(0, -1) + (code.endsWith("a") ? "b" : "a");
    assert.equal((await app.fetch(`/${mistyped}`)).status, 404);
    assert.equal((await app.fetch(`/${code}`)).status, 302);
  });

  test("counts every redirect, and only redirects", async (app) => {
    assert.equal((await stats(app)).redirects, 0);

    const { code } = (await (await shorten(app, "https://example.com/")).json()) as { code: string };
    assert.equal((await stats(app)).redirects, 0, "making a link is not a redirect");

    for (let i = 0; i < 3; i++) assert.equal((await app.fetch(`/${code}`)).status, 302);
    assert.equal((await stats(app)).redirects, 3);

    await app.fetch("/abc123");
    assert.equal((await stats(app)).redirects, 3, "a link that does not exist is not counted");
  });

  test("counts the databases that keep links, out of billions possible", async (app) => {
    const before = await stats(app);
    assert.equal(before.databases, 0);
    assert.equal(before.possibleDatabases, 36 ** 6);
    assert.equal(before.possibleLinks, 36 ** 7);

    // Three random codes sharing a database is a one in a billion event.
    for (let i = 0; i < 3; i++) await shorten(app, `https://example.com/${i}`);
    assert.equal((await stats(app)).databases, 3);

    await app.fetch("/abc123");
    assert.equal((await stats(app)).databases, 3, "looking for a link is not counted");
  });

  test("accepts only web addresses", async (app) => {
    for (const url of ["javascript:alert(1)", "ftp://example.com", "example", "", null]) {
      assert.equal((await shorten(app, url)).status, 400, `rejects ${JSON.stringify(url)}`);
    }
    assert.equal((await app.fetch("/api/links", { method: "POST", body: "not json" })).status, 400);
  });

  test("limits how many links one visitor creates in an hour", async (app) => {
    for (let i = 0; i < 20; i++) assert.equal((await shorten(app, `https://example.com/${i}`)).status, 201);
    assert.equal((await shorten(app, "https://example.com/one-too-many")).status, 429);
  });
}
