import type { Tests } from "../deps/testing.ts";
import { FIXTURE, helpers, secrets } from "./test-helpers.ts";

// The files of a source: uploaded, replaced, listed and removed through the
// API, by the console or by a script that holds an administrator key.
export default function ({ test, assert }: Tests) {
  const { json, createAdmin, createReader, uploadSource, audit } = helpers(assert);

  interface FileRow { path: string; size: number; content_type: string; updated_at: number }
  interface FileList { items: FileRow[]; next_after: string | null }

  const files = (alias: string, path = ""): string => `/api/admin/sources/${alias}/files${path ? `/${path}` : ""}`;

  test("files: added, replaced, listed, read back and removed through the API", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const cookie = { cookie: admin };
    const put = (path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> =>
      app.fetch(files("docs", path), { method: "PUT", headers: { ...cookie, ...headers }, body });
    const list = async (query = ""): Promise<FileList> => (await (await app.fetch(`${files("docs")}${query}`, { headers: cookie })).json()) as FileList;

    // A file needs its source first.
    assert.equal((await put("index.html", "<h1>One</h1>")).status, 404);
    assert.equal((await app.fetch(files("docs"), { headers: cookie })).status, 404);
    assert.equal((await app.fetch("/api/admin/sources", json("POST", { alias: "docs", public: true }, cookie))).status, 201);
    assert.equal(await list(), { items: [], next_after: null });

    // 201 for a new file, 200 for a replacement. The type comes from the name, whatever the request says.
    const first = await put("index.html", "<h1>One</h1>", { "content-type": "application/x-anything" });
    assert.equal(first.status, 201);
    const saved = (await first.json()) as FileRow;
    assert.equal([saved.path, saved.size, saved.content_type], ["index.html", 12, "text/html; charset=utf-8"]);
    assert((await (await app.fetch("/reader/view/docs/")).text()).includes("<h1>One</h1>"));
    assert.equal((await put("index.html", "<h1>Two, longer</h1>")).status, 200);
    // Readers see the change at once.
    assert((await (await app.fetch("/reader/view/docs/")).text()).includes("<h1>Two, longer</h1>"));

    const image = new Uint8Array([137, 80, 78, 71, 0, 255, 1, 2]);
    assert.equal(((await (await put("img/pixel.png", image, { "content-type": "text/html" })).json()) as FileRow).content_type, "image/png");
    assert.equal(((await (await put("img/Photo%20one.JPG", image)).json()) as FileRow).path, "img/Photo one.JPG");
    assert.equal(((await (await put("data/notes.unknown-kind", "x")).json()) as FileRow).content_type, "application/octet-stream");

    // The listing is in path order, by prefix and in parts.
    assert.equal((await list()).items.map((file) => file.path), ["data/notes.unknown-kind", "img/Photo one.JPG", "img/pixel.png", "index.html"]);
    assert.equal((await list("?q=img/")).items.map((file) => file.path), ["img/Photo one.JPG", "img/pixel.png"]);
    const part = await list("?limit=3");
    assert.equal([part.items.length, part.next_after], [3, "img/pixel.png"]);
    assert.equal(await list(`?limit=3&after=${encodeURIComponent(part.next_after ?? "")}`).then((page) => [page.items.map((file) => file.path), page.next_after]), [["index.html"], null]);

    // The source says how much it holds.
    const source = (await (await app.fetch("/api/admin/sources/docs", { headers: cookie })).json()) as { files: number; bytes: number };
    assert.equal([source.files, source.bytes], [4, 20 + 8 + 8 + 1]);

    // Read back as it was uploaded, as a download: a source's page never opens as a page of the console.
    const raw = await app.fetch(files("docs", "img/pixel.png"), { headers: cookie });
    assert.equal([raw.status, raw.headers.get("content-type"), raw.headers.get("content-disposition")], [200, "image/png", "attachment"]);
    assert((raw.headers.get("content-security-policy") ?? "").includes("sandbox"));
    assert.equal([...new Uint8Array(await raw.arrayBuffer())], [...image]);
    const served = await app.fetch("/reader/view/docs/img/pixel.png");
    assert.equal([served.status, served.headers.get("content-type")], [200, "image/png"]);
    assert.equal([...new Uint8Array(await served.arrayBuffer())], [...image]);
    assert.equal((await app.fetch("/reader/view/docs/img/Photo%20one.JPG")).headers.get("content-type"), "image/jpeg");

    // Removed: gone for readers at once, and removing it twice says so.
    assert.equal((await app.fetch(files("docs", "img/pixel.png"), { method: "DELETE", headers: cookie })).status, 200);
    assert.equal((await app.fetch(files("docs", "img/pixel.png"), { method: "DELETE", headers: cookie })).status, 404);
    assert.equal((await app.fetch(files("docs", "img/pixel.png"), { headers: cookie })).status, 404);
    assert.equal((await app.fetch("/reader/view/docs/img/pixel.png")).status, 404);
    const after = (await (await app.fetch("/api/admin/sources/docs", { headers: cookie })).json()) as { files: number; bytes: number };
    assert.equal([after.files, after.bytes], [3, 29]);
  });

  test("files: a path that leaves the source, a hidden file, a clash and a file too large are refused", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const cookie = { cookie: admin };
    await uploadSource(app, admin);
    const put = (path: string, body: BodyInit = "x"): Promise<Response> => app.fetch(files("example", path), { method: "PUT", headers: cookie, body });
    for (const path of ["a%5Cb", ".hidden", "dir/.git/config", "..%2Fsecret.txt", "a%00b", `${"x".repeat(901)}.txt`, ""]) {
      assert.equal((await put(path)).status, 400, path);
      assert.equal((await app.fetch(files("example", path || "/"), { method: "DELETE", headers: cookie })).status, 400, path);
    }
    // A name is a file or a folder, never both.
    assert.equal((await put("style.css/extra.css")).status, 409);
    assert.equal((await put("about")).status, 409);
    assert.equal((await put("img")).status, 409);
    assert.equal((await put("about-us")).status, 201);

    // One byte over the limit.
    const refused = await put("big.bin", new Uint8Array(25 * 1024 * 1024 + 1));
    assert.equal(refused.status, 413);
    assert(((await refused.json()) as { error: string }).error.includes("25 MB"));
    assert.equal((await app.fetch(files("example", "big.bin"), { headers: cookie })).status, 404);
  });

  test("files: an administrator key publishes from anywhere; a reader key, another site and a visitor do not", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    await uploadSource(app, admin);
    const { key } = (await (await app.fetch("/api/admin/api-keys", { method: "POST", headers: { cookie: admin } })).json()) as { key: string };
    const readerKey = ((await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string }).key;
    const attempt = (method: string, headers: Record<string, string>): Promise<Response> =>
      app.fetch(files("example", "new.txt"), { method, headers, ...(method === "PUT" ? { body: "hello" } : {}) });

    for (const method of ["PUT", "GET", "DELETE"]) {
      assert.equal((await attempt(method, {})).status, 401, method);
      assert.equal((await attempt(method, { authorization: `Bearer ${readerKey}` })).status, 401, method);
      assert.equal((await attempt(method, { cookie: leo.cookie })).status, 401, method);
    }
    assert.equal((await app.fetch(files("example"), { headers: { authorization: `Bearer ${readerKey}` } })).status, 401);
    // A browser on another site, carrying the administrator's cookie, changes nothing.
    assert.equal((await attempt("PUT", { cookie: admin, origin: "https://fake-site.example" })).status, 403);
    assert.equal((await attempt("DELETE", { cookie: admin, origin: "https://fake-site.example" })).status, 403);
    assert.equal((await attempt("GET", { cookie: admin })).status, 404);

    // A key is its own credential: a script sends no cookie, and no origin worth checking.
    const script = { authorization: `Bearer ${key}`, origin: "https://ci.example" };
    assert.equal((await attempt("PUT", script)).status, 201);
    assert.equal(await (await attempt("GET", script)).text(), "hello");
    assert.equal(((await (await app.fetch(`${files("example")}?q=new`, { headers: script })).json()) as FileList).items.length, 1);
    assert.equal((await attempt("DELETE", script)).status, 200);
    assert.equal((await app.fetch("/api/admin/sources", json("POST", { alias: "by-script" }, script))).status, 201);
    assert.equal((await app.fetch("/api/admin/sources/by-script", { method: "DELETE", headers: script })).status, 200);
  });

  test("files: source.json is applied as soon as it is uploaded, and never delivered", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const cookie = { cookie: admin };
    assert.equal((await app.fetch("/api/admin/sources", json("POST", { alias: "site", public: true }, cookie))).status, 201);
    const put = (path: string, body: string): Promise<Response> => app.fetch(files("site", path), { method: "PUT", headers: cookie, body });
    await put("index.html", "<p>[{{ props.title }}]</p>");
    await put("style.css", "/* {{ props.title }} */");
    const page = async (path: string): Promise<string> => (await app.fetch(`/reader/view/site/${path}`)).text();
    assert((await page("")).includes("<p>[]</p>"));
    const source = async (): Promise<{ origin: string; render: string[]; problems: string[] }> =>
      (await (await app.fetch("/api/admin/sources/site", { headers: cookie })).json()) as { origin: string; render: string[]; problems: string[] };
    assert.equal([(await source()).origin, (await source()).render], ["default", ["html"]]);

    await put("source.json", JSON.stringify({ render: ["html", "css"], props: { title: "Handbook" } }));
    assert((await page("")).includes("<p>[Handbook]</p>"));
    assert.equal(await page("style.css"), "/* Handbook */");
    assert.equal([(await source()).origin, (await source()).render], ["file", ["html", "css"]]);
    // For the system and the administrator, never for a reader.
    assert.equal((await app.fetch("/reader/view/site/source.json")).status, 404);
    assert.equal((await app.fetch(files("site", "source.json"), { headers: cookie })).status, 200);

    // A broken one falls back to the defaults and says what is wrong.
    await put("source.json", "{ not json");
    assert.equal(await page("style.css"), "/* {{ props.title }} */");
    assert.equal((await source()).problems.length, 1);
    // Without it, the defaults again.
    assert.equal((await app.fetch(files("site", "source.json"), { method: "DELETE", headers: cookie })).status, 200);
    assert.equal((await source()).origin, "default");

    // What is not rendered is revalidated by the browser, and a new upload is a new version.
    const css = await app.fetch("/reader/view/site/style.css");
    const etag = css.headers.get("etag") ?? "";
    await css.arrayBuffer();
    assert(etag !== "");
    assert.equal((await app.fetch("/reader/view/site/style.css", { headers: { "if-none-match": etag } })).status, 304);
    await put("style.css", "body { margin: 0 }");
    const changed = await app.fetch("/reader/view/site/style.css", { headers: { "if-none-match": etag } });
    assert.equal([changed.status, await changed.text()], [200, "body { margin: 0 }"]);
  });

  test("files: a whole upload is one audit row that counts, and removing a source clears what it stored", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const cookie = { cookie: admin };
    const source = await uploadSource(app, admin, { public: true });
    const target = { type: "source", id: "example", name: "example" };
    assert.equal((await audit(app, admin, "action=source.created")).map((row) => [row.actor.name, row.target, row.details]), [["ana", target, { public: true }]]);
    assert.equal((await audit(app, admin, "action=source.files.uploaded")).map((row) => [row.actor.name, row.actor.via, row.target, row.details]),
      [["ana", "session", target, { count: source.files }]]);
    for (const path of ["style.css", "img/logo.svg"]) {
      assert.equal((await app.fetch(files("example", path), { method: "DELETE", headers: cookie })).status, 200);
    }
    assert.equal((await audit(app, admin, "action=source.files.removed")).map((row) => row.details), [{ count: 2 }]);

    // The source goes with everything: its rows at once, its stored files right after or by the scheduled job.
    const removed = await app.fetch("/api/admin/sources/example", { method: "DELETE", headers: cookie });
    assert.equal([removed.status, await removed.json()], [200, { ok: true, files_pending: 0 }]);
    assert.equal((await audit(app, admin, "action=source.removed")).map((row) => row.target), [target]);
    assert.equal((await app.fetch("/reader/view/example/")).status, 303);
    await app.runCron("2090-01-01T00:01:00Z");
    // The same alias again is a new, empty source: nothing of the old one comes back.
    assert.equal((await app.fetch("/api/admin/sources", json("POST", { alias: "example", public: true }, cookie))).status, 201);
    assert.equal((await app.fetch("/reader/view/example/index.html")).status, 404);
    assert.equal((await app.fetch(files("example", "index.html"), { headers: cookie })).status, 404);
  });

  test("files: the console creates a source, lists its files, removes one and offers the folder upload", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const cookie = { cookie: admin };
    const form = (path: string, fields: Record<string, string>): Promise<Response> => app.fetch(path, { method: "POST", headers: cookie, body: new URLSearchParams(fields) });
    const text = async (path: string): Promise<string> => (await app.fetch(path, { headers: cookie })).text();

    assert((await text("/admin/list-sources")).includes('href="/admin/create-source"'));
    assert((await text("/admin/create-source")).includes('name="alias"'));
    const refused = await form("/admin/create-source", { alias: "Not Valid" });
    assert((refused.headers.get("location") ?? "").startsWith("/admin/create-source?error="));
    const created = await form("/admin/create-source", { alias: "handbook" });
    assert((created.headers.get("location") ?? "").startsWith("/admin/edit-source?source=handbook&ok="));
    assert((await text("/admin/list-sources")).includes("No files"));

    // The page of an empty source says so, and carries the upload: a folder picker and the script that sends it.
    const empty = await text("/admin/edit-source?source=handbook");
    assert(empty.includes("This source has no files yet") && empty.includes('id="upload" data-alias="handbook"') && empty.includes("webkitdirectory"));
    const script = /<script src="(\/assets\/upload\.js\?v=[a-z0-9]+)" defer>/.exec(empty)?.[1] ?? "";
    const served = await app.fetch(script);
    assert.equal([served.status, (served.headers.get("content-type") ?? "").startsWith("text/javascript")], [200, true]);
    assert((await served.text()).includes("/api/admin/sources/"));

    for (const [path, content] of Object.entries(FIXTURE)) {
      assert.equal((await app.fetch(files("handbook", path), { method: "PUT", headers: cookie, body: content })).status, 201, path);
    }
    const full = await text("/admin/edit-source?source=handbook");
    assert(!full.includes("This source has no files yet"));
    for (const path of Object.keys(FIXTURE)) assert(full.includes(`<code>${path}</code>`), path);
    assert(full.includes('href="/reader/view/handbook/img/logo.svg"') && !full.includes('href="/reader/view/handbook/source.json"'));
    assert((await text("/admin/edit-source?source=handbook&q=img/")).includes("<code>img/logo.svg</code>"));
    assert(!(await text("/admin/edit-source?source=handbook&q=img/")).includes("<code>style.css</code>"));

    const gone = await form("/admin/edit-source?source=handbook", { action: "delete-file", path: "style.css" });
    assert((gone.headers.get("location") ?? "").startsWith("/admin/edit-source?source=handbook&ok="));
    assert(!(await text("/admin/edit-source?source=handbook")).includes("<code>style.css</code>"));
    const twice = await form("/admin/edit-source?source=handbook", { action: "delete-file", path: "style.css" });
    assert((twice.headers.get("location") ?? "").includes("error="));

    const removed = await form("/admin/edit-source?source=handbook", { action: "delete" });
    assert((removed.headers.get("location") ?? "").startsWith("/admin/list-sources?ok="));
    assert.equal((await app.fetch("/admin/edit-source?source=handbook", { headers: cookie })).status, 404);
  });
}
