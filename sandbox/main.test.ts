import type { Tests } from "../deps/testing.ts";
import { safeNext } from "./pages.ts";
import { parseSourceConfig } from "./source-config.ts";
import { render } from "./template.ts";
import { ROOT, helpers, secrets } from "./test-helpers.ts";

export default function ({ test, assert }: Tests) {
  const { json, cookieOf, createAdmin, createReader, uploadSource, audit } = helpers(assert);

  const escaped = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // -------------------------------------------------------------------------
  // Template engine
  // -------------------------------------------------------------------------

  test("template: variables, if/else, loops and raw block", () => {
    const scope = { props: { site: "my.site", age: 30, items: ["a", "b"] }, query: { page: "2" }, headers: { "accept-language": "en-GB" } };
    assert.equal(render("{{ props.site }}|{{ query.page }}|{{ headers.accept-language }}", scope), "my.site|2|en-GB");
    assert.equal(render("{% if props.age >= 18 %}adult{% else %}restricted{% endif %}", scope), "adult");
    assert.equal(render("{% if props.age < 18 %}a{% elsif query.page == 2 %}b{% else %}c{% endif %}", scope), "b");
    assert.equal(render("{% for i in props.items %}{{ forloop.index }}{{ i }}{% endfor %}", scope), "1a2b");
    assert.equal(render("{% for i in props.nothing %}x{% else %}empty{% endfor %}", scope), "empty");
    assert.equal(render("{% raw %}{{ props.site }}{% if %}{% endraw %}", scope), "{{ props.site }}{% if %}");
  });

  test("template: escapes by default and reaches nothing but the data", () => {
    const scope = { props: { name: `<script>alert("x")</script>` } };
    assert.equal(render("{{ props.name }}", scope), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    assert.equal(render("{{ props.name | raw }}", scope), `<script>alert("x")</script>`);
    assert.equal(render("{{ props.constructor }}{{ props.__proto__ }}{{ props.name.constructor }}", scope), "");
    let message = "";
    try {
      render("line 1\n{% if props.name %}no end", scope);
    } catch (error) {
      message = (error as Error).message;
    }
    assert(message.includes("line 2"), message);
  });

  test("the return address of the sign-in only accepts internal source paths", () => {
    assert.equal(safeNext("/reader/view/example/index.html?page=2"), "/reader/view/example/index.html?page=2");
    for (const bad of ["https://fake-site", "//fake-site", "/reader/view//fake-site", "/reader/view/a\\b", "/admin/home", "/reader/home", "", null]) {
      assert.equal(safeNext(bad), null);
    }
  });

  // -------------------------------------------------------------------------
  // Root and sign-in
  // -------------------------------------------------------------------------

  test("root: a wrong password is refused and the attempt limit blocks even the right one", { secrets }, async (app) => {
    assert.equal((await app.fetch("/root/setup")).status, 200);
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await app.fetch("/api/root/admins", { headers: { "x-root-password": "wrong" } })).status, 401);
    }
    assert.equal((await app.fetch("/api/root/admins", { headers: { "x-root-password": ROOT } })).status, 429);
  });

  test("root creates the first administrator, who signs in with a protected cookie", { secrets }, async (app) => {
    assert.equal((await app.fetch("/admin/home")).headers.get("location"), "/admin/");
    const created = await app.fetch("/api/root/admins", json("POST", { username: "ana", password: "ana-password" }, { "x-root-password": ROOT }));
    assert.equal(created.status, 201);

    const wrong = await app.fetch("/admin/", { method: "POST", body: new URLSearchParams({ username: "ana", password: "another-password" }) });
    assert.equal(wrong.headers.getSetCookie().length, 0);
    assert((wrong.headers.get("location") ?? "").startsWith("/admin/?error="));

    const login = await app.fetch("/admin/", { method: "POST", body: new URLSearchParams({ username: "ana", password: "ana-password" }) });
    assert.equal(login.headers.get("location"), "/admin/home");
    const setCookie = login.headers.getSetCookie()[0] ?? "";
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax"]) assert(setCookie.includes(attribute), `missing ${attribute}`);

    const cookie = cookieOf(login);
    assert.equal((await app.fetch("/admin/home", { headers: { cookie } })).status, 200);
    assert.equal((await app.fetch("/admin/", { headers: { cookie } })).headers.get("location"), "/admin/home");
    // The administrator cookie is not valid as a reader.
    assert.equal((await app.fetch("/reader/home", { headers: { cookie } })).headers.get("location"), "/reader/");
  });

  test("sign-out only by POST, and the token stops working at once", { secrets }, async (app) => {
    const cookie = await createAdmin(app);
    assert.equal((await app.fetch("/admin/logout", { headers: { cookie } })).status, 405);
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie } })).status, 200);
    const out = await app.fetch("/admin/logout", { method: "POST", headers: { cookie } });
    assert.equal(out.headers.get("location"), "/admin/");
    assert((out.headers.getSetCookie()[0] ?? "").includes("Max-Age=0"));
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie } })).status, 401);
  });

  test("a cookie-authenticated change coming from another site is refused", { secrets }, async (app) => {
    const cookie = await createAdmin(app);
    const forged = await app.fetch("/api/admin/config", json("PUT", { props: { a: 1 } }, { cookie, origin: "https://fake-site.example" }));
    assert.equal(forged.status, 403);
    assert.equal((await app.fetch("/api/admin/config", json("PUT", { props: { a: 1 } }, { cookie }))).status, 200);
  });

  test("a new password or the removal of the user ends the sessions; only removal ends the keys", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    const { key } = (await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string };
    assert.equal((await app.fetch("/api/reader/me", { headers: { authorization: `Bearer ${key}` } })).status, 200);

    // Nobody sets a reader's password for them: the reader chooses a new one through a new link.
    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", { password: "leo-new-password" }, { cookie: admin }))).status, 400);
    assert.equal((await app.fetch("/api/reader/me", { headers: { cookie: leo.cookie } })).status, 200);
    const issued = (await (await app.fetch(`/api/admin/readers/${leo.id}/invite`, { method: "POST", headers: { cookie: admin } })).json()) as { url: string };
    const again = cookieOf(await app.fetch(`/api${new URL(issued.url).pathname}`, json("POST", { password: "leo-new-password" })));
    assert.equal((await app.fetch("/api/reader/me", { headers: { cookie: leo.cookie } })).status, 401);
    assert.equal((await app.fetch("/api/reader/me", { headers: { cookie: again } })).status, 200);
    // API keys are not affected by a password change, only by removal.
    assert.equal((await app.fetch("/api/reader/me", { headers: { authorization: `Bearer ${key}` } })).status, 200);
    assert.equal((await app.fetch("/api/reader/login", json("POST", { username: "leo", password: "leo-password" }))).status, 401);
    assert.equal((await app.fetch("/api/reader/login", json("POST", { username: "leo", password: "leo-new-password" }))).status, 200);

    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}`, { method: "DELETE", headers: { cookie: admin } })).status, 200);
    assert.equal((await app.fetch("/api/reader/me", { headers: { cookie: again } })).status, 401);
    assert.equal((await app.fetch("/api/reader/me", { headers: { authorization: `Bearer ${key}` } })).status, 401);
  });

  test("API: 401 without authentication, each role's key only under its own prefix", { secrets }, async (app) => {
    assert.equal((await app.fetch("/api/admin/sources")).status, 401);
    assert.equal((await app.fetch("/api/reader/sources")).status, 401);
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    const adminKey = ((await (await app.fetch("/api/admin/api-keys", { method: "POST", headers: { cookie: admin } })).json()) as { key: string }).key;
    const readerKey = ((await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string }).key;
    assert.equal((await app.fetch("/api/admin/sources", { headers: { authorization: `Bearer ${adminKey}` } })).status, 200);
    assert.equal((await app.fetch("/api/admin/sources", { headers: { authorization: `Bearer ${readerKey}` } })).status, 401);
    assert.equal((await app.fetch("/api/reader/sources", { headers: { authorization: `Bearer ${adminKey}` } })).status, 401);

    // The listing shows the identifier, never the key; once revoked, it stops working.
    const list = (await (await app.fetch("/api/admin/api-keys", { headers: { cookie: admin } })).json()) as { items: Record<string, unknown>[] };
    assert.equal(Object.keys(list.items[0]!).sort(), ["created_at", "expires_at", "id", "last_used_at", "name"]);
    await app.fetch(`/api/admin/api-keys/${String(list.items[0]!.id)}`, { method: "DELETE", headers: { cookie: admin } });
    assert.equal((await app.fetch("/api/admin/sources", { headers: { authorization: `Bearer ${adminKey}` } })).status, 401);
  });

  test("invalid input is refused with a message", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const post = (path: string, body: unknown) => app.fetch(path, json("POST", body, { cookie: admin }));
    // A reader needs an email and never gets a password from the administrator.
    assert.equal((await post("/api/admin/readers", { username: "leo" })).status, 400);
    assert.equal((await post("/api/admin/readers", { username: "leo", email: "not-an-email" })).status, 400);
    assert.equal((await post("/api/admin/readers", { username: "leo", email: "leo@example.test", password: "leo-password" })).status, 400);
    assert.equal((await post("/api/admin/readers", { username: "x", email: "leo@example.test" })).status, 400);
    assert.equal((await post("/api/admin/readers", { username: "leo", email: "leo@example.test" })).status, 201);
    // A name is taken whatever its case, and so is an email.
    for (const [taken, message] of [[{ username: "LEO", email: "other@example.test" }, "name"], [{ username: "lea", email: "Leo@Example.test" }, "email"]] as const) {
      const refused = await post("/api/admin/readers", taken);
      assert.equal(refused.status, 409);
      assert(((await refused.json()) as { error: string }).error.includes(message), message);
    }
    assert.equal((await post("/api/admin/admins", { username: "ANA", password: "another-password" })).status, 409);
    assert.equal((await post("/api/admin/admins", { username: "bia", password: "short" })).status, 400);
    // A source is created by its alias; its rendering settings are not changed through the API, only by its source.json.
    for (const alias of ["Example", "with space", "a/b", "", "x".repeat(65)]) assert.equal((await post("/api/admin/sources", { alias })).status, 400, alias);
    assert.equal((await post("/api/admin/sources", { alias: "example" })).status, 201);
    assert.equal((await post("/api/admin/sources", { alias: "example" })).status, 409);
    for (const change of [{ render: [] }, { props: { title: "x" } }, {}]) {
      assert.equal((await app.fetch("/api/admin/sources/example", json("PUT", change, { cookie: admin }))).status, 400);
    }
    assert.equal((await app.fetch("/api/admin/sources/does-not-exist", json("PUT", { public: true }, { cookie: admin }))).status, 404);
    assert.equal((await app.fetch("/api/admin/sources/does-not-exist", { method: "DELETE", headers: { cookie: admin } })).status, 404);
    assert.equal((await app.fetch("/api/admin/config", json("PUT", { props: [1, 2] }, { cookie: admin }))).status, 400);
  });

  // -------------------------------------------------------------------------
  // Reading the sources
  // -------------------------------------------------------------------------

  test("the sites/ folder is never served directly, only through the system", { secrets }, async (app) => {
    for (const path of ["/example/index.html", "/example/", "/example/style.css", "/README.md", "/sites/sources/example/index.html", "/sources/example/index.html"]) {
      const response = await app.fetch(path);
      assert(response.status === 404 || response.status === 405, `${path} answered ${response.status}`);
    }
  });

  test("sources: one exists once it is created, private, and nothing in the repository is one", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const listed = async (): Promise<{ alias: string; public: boolean; files: number }[]> =>
      ((await (await app.fetch("/api/admin/sources", { headers: { cookie: admin } })).json()) as { items: { alias: string; public: boolean; files: number }[] }).items;
    // No folder of sites/ is a source: not sites/label/, not whatever an installation still keeps in sites/sources/.
    assert.equal(await listed(), []);
    for (const alias of ["label", "sources", "example", "does-not-exist"]) {
      assert.equal((await app.fetch(`/api/admin/sources/${alias}`, { headers: { cookie: admin } })).status, 404, alias);
    }
    const example = await uploadSource(app, admin);
    assert.equal([example.origin, example.render, example.props], ["file", ["html"], { title: "Props & templates" }]);
    assert.equal((await listed()).map((source) => [source.alias, source.public, source.files]), [["example", false, example.files]]);
    assert((await (await app.fetch("/admin/list-sources", { headers: { cookie: admin } })).text()).includes('href="/admin/edit-source?source=example"'));
    // The reader's permission list offers it at once.
    const leo = await createReader(app, admin);
    assert((await (await app.fetch(`/admin/edit-reader?reader-id=${leo.id}`, { headers: { cookie: admin } })).text()).includes('name="sources" value="example"'));
    await app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", { sources: ["example"] }, { cookie: admin }));
    assert.equal((await app.fetch("/reader/view/example/style.css", { headers: { cookie: leo.cookie } })).status, 200);
    // Removing it takes its files and its permissions along: the same alias, created again, is empty and shared with nobody.
    assert.equal((await app.fetch("/api/admin/sources/example", { method: "DELETE", headers: { cookie: admin } })).status, 200);
    assert.equal((await app.fetch("/api/admin/sources/example", { headers: { cookie: admin } })).status, 404);
    assert.equal((await app.fetch("/api/admin/sources", json("POST", { alias: "example" }, { cookie: admin }))).status, 201);
    assert.equal((await listed()).map((source) => [source.alias, source.files]), [["example", 0]]);
    assert.equal((await app.fetch("/reader/view/example/style.css", { headers: { cookie: leo.cookie } })).status, 403);
  });

  test("source.json: read key by key, with a default for whatever is wrong", () => {
    assert.equal(parseSourceConfig({ render: [".HTML", "css", "html"], props: { title: "Handbook" } }), { render: ["html", "css"], props: { title: "Handbook" }, problems: [] });
    assert.equal(parseSourceConfig({}), { render: ["html"], props: {}, problems: [] });
    // An empty list turns rendering off.
    assert.equal(parseSourceConfig({ render: [] }).render, []);
    for (const broken of [null, [], "html", 3]) {
      const config = parseSourceConfig(broken);
      assert.equal([config.render, config.props, config.problems.length], [["html"], {}, 1]);
    }
    const wrong = parseSourceConfig({ render: "html", props: [1], public: true });
    assert.equal([wrong.render, wrong.props, wrong.problems.length], [["html"], {}, 3]);
    assert.equal(parseSourceConfig({ render: ["html", "../x"] }).render, ["html"]);
    assert.equal(parseSourceConfig({ render: Array.from({ length: 31 }, (_, index) => `e${index}`) }).problems.length, 1);
    assert.equal(parseSourceConfig({ props: { big: "x".repeat(70_000) } }).props, {});
  });

  test("private source: sign-in with return, no access, and aliases that do not reveal themselves", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    await uploadSource(app, admin);
    const page = "/reader/view/example/index.html?page=7";
    const login = `/reader/?next=${encodeURIComponent(page)}`;

    // Visitor: a private alias and a nonexistent alias get the same answer.
    assert.equal((await app.fetch(page)).headers.get("location"), login);
    assert.equal((await app.fetch("/reader/view/does-not-exist/index.html?page=7")).headers.get("location"), login.replace("example", "does-not-exist"));

    const { id } = await createReader(app, admin);
    const entered = await app.fetch(login, { method: "POST", body: new URLSearchParams({ username: "leo", password: "leo-password" }) });
    assert.equal(entered.headers.get("location"), page);
    const cookie = cookieOf(entered);
    // A `next` pointing outside is ignored.
    const outside = await app.fetch("/reader/?next=https://fake-site.example", { headers: { cookie } });
    assert.equal(outside.headers.get("location"), "/reader/home");

    // Signed in without permission: "no access", never back to sign-in. The same for a nonexistent alias.
    assert.equal((await app.fetch(page, { headers: { cookie } })).status, 403);
    assert.equal((await app.fetch("/reader/view/does-not-exist/", { headers: { cookie } })).status, 403);

    await app.fetch(`/api/admin/readers/${id}`, json("PUT", { sources: ["example"] }, { cookie: admin }));
    const allowed = await app.fetch(page, { headers: { cookie } });
    assert.equal(allowed.status, 200);
    assert((await allowed.text()).includes("Page asked in the query: 7"));
    const home = await (await app.fetch("/reader/home", { headers: { cookie } })).text();
    assert(home.includes('href="/reader/view/example/"'));

    // The same source inside a frame: the top bar stays, and only that page may hold an iframe.
    const homePage = await app.fetch("/reader/home", { headers: { cookie } });
    assert(!(homePage.headers.get("content-security-policy") ?? "").includes("frame-src"));
    assert(home.includes('href="/reader/frame/example"'));
    const framed = await app.fetch("/reader/frame/example", { headers: { cookie } });
    assert.equal(framed.status, 200);
    assert((framed.headers.get("content-security-policy") ?? "").includes("frame-src 'self'"));
    const frame = await framed.text();
    assert(frame.includes('<header class="top"'));
    assert(frame.includes('<iframe class="frame" src="/reader/view/example/"'));
    assert.equal((await app.fetch("/reader/frame/does-not-exist", { headers: { cookie } })).status, 403);

    // Revoking applies at once.
    await app.fetch(`/api/admin/readers/${id}`, json("PUT", { sources: [] }, { cookie: admin }));
    assert.equal((await app.fetch(page, { headers: { cookie } })).status, 403);
    assert.equal((await app.fetch("/reader/frame/example", { headers: { cookie } })).status, 403);
  });

  test("props: platform < source < reader, and credentials never reach the template", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    await app.fetch("/api/admin/config", json("PUT", { props: { title: "From the <platform>", theme: "light" } }, { cookie: admin }));
    const example = await uploadSource(app, admin, { public: true });

    // Visitor on a public source: the platform props, and over them the props of the source's source.json.
    const visitor = await (await app.fetch("/reader/view/example/", { headers: { "accept-language": "en-GB" } })).text();
    assert(visitor.includes(`<h1>${escaped(String(example.props.title))}</h1>`));
    assert(visitor.includes("Browser language: en-GB"));
    assert(visitor.includes("Inside a raw block, {{ this }} and {% this %}"));
    assert(!visitor.includes("the <strong>dark</strong> theme"));
    // The settings file is for the system: no reader receives it.
    assert.equal((await app.fetch("/reader/view/example/source.json")).status, 404);

    const leo = await createReader(app, admin);
    await app.fetch("/api/reader/props", json("PUT", { props: { title: "From the reader", theme: "dark", notices: ["one", "two"] } }, { cookie: leo.cookie }));
    const reader = await (await app.fetch("/reader/view/example/", { headers: { cookie: leo.cookie } })).text();
    assert(reader.includes("<h1>From the reader</h1>"));
    assert(reader.includes("the <strong>dark</strong> theme"));
    assert(reader.includes("2. two"));
  });

  test("props: an administrator reads and replaces the props of any reader", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    await uploadSource(app, admin, { public: true });
    const leo = await createReader(app, admin);
    const put = (id: string, props: unknown, headers: Record<string, string> = { cookie: admin }) => app.fetch(`/api/admin/readers/${id}/props`, json("PUT", { props }, headers));
    const detail = async () => (await (await app.fetch(`/api/admin/readers/${leo.id}`, { headers: { cookie: admin } })).json()) as { props: unknown };
    assert.equal((await detail()).props, {});

    const chosen = { title: "From the administrator", theme: "dark" };
    assert.equal((await put(leo.id, chosen)).status, 200);
    assert.equal((await detail()).props, chosen);
    // The reader has them at once: in the pages and in their own preferences.
    assert((await (await app.fetch("/reader/view/example/", { headers: { cookie: leo.cookie } })).text()).includes("<h1>From the administrator</h1>"));
    assert.equal(await (await app.fetch("/api/reader/props", { headers: { cookie: leo.cookie } })).json(), { props: chosen });
    // The list of readers does not carry them: they can be large.
    assert(!(await (await app.fetch("/api/admin/readers", { headers: { cookie: admin } })).text()).includes("From the administrator"));

    // Refused: what is not a JSON object, a reader who does not exist, and whoever is not an administrator.
    assert.equal((await put(leo.id, [1, 2])).status, 400);
    assert.equal((await put(leo.id, "{not json")).status, 400);
    assert.equal((await put("does-not-exist", { a: 1 })).status, 404);
    assert.equal((await put(leo.id, { a: 1 }, {})).status, 401);
    assert.equal((await put(leo.id, { a: 1 }, { cookie: leo.cookie })).status, 401);
    assert.equal((await detail()).props, chosen);

    // The same in the console, on the reader's page.
    const page = `/admin/edit-reader?reader-id=${leo.id}`;
    const post = (props: string) => app.fetch(page, { method: "POST", headers: { cookie: admin }, body: new URLSearchParams({ action: "props", props }) });
    assert((await (await app.fetch(page, { headers: { cookie: admin } })).text()).includes('name="props"'));
    assert(((await post('{"plan": "gold"}')).headers.get("location") ?? "").startsWith(`${page}&ok=`));
    assert.equal((await detail()).props, { plan: "gold" });
    assert(((await post("{this is not json")).headers.get("location") ?? "").startsWith(`${page}&error=`));
    assert.equal((await detail()).props, { plan: "gold" });

    // The log names the administrator who did it, and the keys, never the values.
    const rows = await audit(app, admin, "action=reader.props.updated");
    assert.equal(rows.length, 2);
    assert.equal([rows[0]!.actor.role, rows[0]!.actor.name, rows[0]!.target?.name, rows[0]!.details], ["admin", "ana", "leo", { keys: ["plan"] }]);
  });

  test("files: a folder becomes index.html, what is not a template stays intact, an address that leaves the folder is refused", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    await uploadSource(app, admin, { public: true });
    assert.equal((await app.fetch("/reader/view/example")).headers.get("location"), "/reader/view/example/");
    assert.equal((await app.fetch("/reader/view/example/about")).headers.get("location"), "/reader/view/example/about/");
    assert((await (await app.fetch("/reader/view/example/about/")).text()).includes("About this example"));
    assert.equal((await app.fetch("/reader/view/example/does-not-exist.html")).status, 404);

    const css = await app.fetch("/reader/view/example/style.css");
    assert.equal(css.status, 200);
    assert((css.headers.get("content-type") ?? "").startsWith("text/css"));
    assert((await css.text()).includes("This file does not go through the template engine"));
    const svg = await app.fetch("/reader/view/example/img/logo.svg");
    assert((svg.headers.get("content-type") ?? "").startsWith("image/svg+xml"));
    await svg.arrayBuffer();

    for (const path of ["/reader/view/example/..%2FREADME.md", "/reader/view/example/.hidden", "/reader/view/example/a%5Cb"]) {
      assert.equal((await app.fetch(path)).status, 400, path);
    }
  });

  test("the reader API serves files with a key and respects the permission", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    await uploadSource(app, admin);
    const leo = await createReader(app, admin);
    const { key } = (await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string };
    const headers = { authorization: `Bearer ${key}` };
    assert.equal((await app.fetch("/api/reader/view/example/index.html")).status, 401);
    assert.equal((await app.fetch("/api/reader/view/example/index.html", { headers })).status, 403);
    await app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", { sources: ["example"] }, { cookie: admin }));
    const file = await app.fetch("/api/reader/view/example/index.html", { headers });
    assert.equal(file.status, 200);
    // The key is not visible to the template, even though it comes in a header.
    assert(!(await file.text()).includes(key));
    assert.equal(await (await app.fetch("/api/reader/sources", { headers })).json(), { items: [{ alias: "example", public: false }] });

    // Revoking the permission closes the source again.
    await app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", { sources: [] }, { cookie: admin }));
    assert.equal((await app.fetch("/api/reader/view/example/index.html", { headers })).status, 403);
    const detail = (await (await app.fetch(`/api/admin/readers/${leo.id}`, { headers: { cookie: admin } })).json()) as { allowed: string[] };
    assert.equal(detail.allowed, []);
  });

  test("the administrator pages open and the forms work", { secrets }, async (app) => {
    const cookie = await createAdmin(app);
    const leo = await createReader(app, cookie);
    const pages = [
      "/admin/home", "/admin/config", "/admin/list-sources", "/admin/list-readers?q=le", "/admin/create-reader",
      `/admin/edit-reader?reader-id=${leo.id}`, "/admin/list-admins", "/admin/create-admin", "/admin/api-keys", "/admin/account",
      "/admin/audit", "/admin/audit?action=login&actor=an&created_from=2020-01-01",
    ];
    for (const path of pages) {
      const response = await app.fetch(path, { headers: { cookie } });
      assert.equal(response.status, 200, path);
      assert((await response.text()).includes('aria-label="Sign out"'), `${path} has no sign-out button`);
    }
    for (const path of ["/reader/home", "/reader/config", "/reader/api-keys", "/reader/account"]) {
      assert.equal((await app.fetch(path, { headers: { cookie: leo.cookie } })).status, 200, path);
    }
    // The source page changes the visibility, and nothing else.
    await uploadSource(app, cookie);
    const edit = await (await app.fetch("/admin/edit-source?source=example", { headers: { cookie } })).text();
    assert(edit.includes("source.json") && !edit.includes('name="props"') && !edit.includes('name="render"'));
    const published = await app.fetch("/admin/edit-source?source=example", { method: "POST", headers: { cookie }, body: new URLSearchParams({ action: "save", public: "on" }) });
    assert((published.headers.get("location") ?? "").startsWith("/admin/edit-source?source=example&ok="));
    assert.equal((await app.fetch("/reader/view/example/style.css")).status, 200);
    const saved = await app.fetch("/admin/config", { method: "POST", headers: { cookie }, body: new URLSearchParams({ props: '{"site": "my.site"}' }) });
    assert((saved.headers.get("location") ?? "").startsWith("/admin/config?ok="));
    assert.equal(await (await app.fetch("/api/admin/config", { headers: { cookie } })).json(), { props: { site: "my.site" } });
    const broken = await app.fetch("/admin/config", { method: "POST", headers: { cookie }, body: new URLSearchParams({ props: "{this is not json" }) });
    assert((broken.headers.get("location") ?? "").startsWith("/admin/config?error="));

    // The key appears once, in the response that generates it.
    const generated = await (await app.fetch("/admin/api-keys", { method: "POST", headers: { cookie }, body: new URLSearchParams({ action: "create" }) })).text();
    const key = /cn_a_[A-Za-z0-9_-]+/.exec(generated)?.[0] ?? "";
    assert(key !== "");
    assert(!(await (await app.fetch("/admin/api-keys", { headers: { cookie } })).text()).includes(key));
  });

  test("white-label: the brand files of sites/label/ are public, and nothing else in it is", { secrets }, async (app) => {
    // The whole design is in sites/label/: the tokens and the stylesheet that uses them.
    // What they say is the installation's business; that they are served as stylesheets is ours.
    for (const path of ["/label/theme.css", "/label/app.css"]) {
      const css = await app.fetch(path);
      assert.equal(css.status, 200, path);
      assert((css.headers.get("content-type") ?? "").startsWith("text/css"));
      await css.arrayBuffer();
    }
    for (const path of ["/label/label.json", "/label/README.md", "/label/..%2Fexample%2Fstyle.css", "/label/.hidden.css"]) {
      assert.equal((await app.fetch(path)).status, 404, path);
    }
    // No stylesheet is built into the code any more.
    const builtIn = await app.fetch("/assets/app.css");
    assert.equal(builtIn.status, 404);
    await builtIn.arrayBuffer();

    // The sign-in page takes its name from label.json and loads the tokens before the rules.
    const signIn = await (await app.fetch("/reader/")).text();
    assert(signIn.includes("/label/theme.css") && signIn.indexOf("/label/theme.css") < signIn.indexOf("/label/app.css"));
    assert(signIn.includes("<title>Sign in · "));

    // Sources are what an administrator uploaded: the label folder is not one.
    assert.equal((await app.fetch("/reader/view/label/theme.css")).status, 303);
  });

  test("the scheduled cleanup deletes expired sessions", { secrets }, async (app) => {
    const cookie = await createAdmin(app);
    await app.runCron("2020-01-01T00:17:00Z");
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie } })).status, 200);
    await app.runCron("2090-01-01T00:17:00Z");
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie } })).status, 401);
  });
}
