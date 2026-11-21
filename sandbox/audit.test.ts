import type { Tests } from "../deps/testing.ts";
import { ROOT, helpers, secrets } from "./test-helpers.ts";

// The audit log: one row for every change, written with the change itself.
export default function ({ test, assert }: Tests) {
  const { json, createAdmin, pendingReader, acceptInvite, createReader, audit } = helpers(assert);

  test("audit: every change to an account leaves a row saying who, what and on whom", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await pendingReader(app, admin);
    await acceptInvite(app, leo.link, "leo-password");
    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", { username: "leonor" }, { cookie: admin }))).status, 200);
    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}`, { method: "DELETE", headers: { cookie: admin } })).status, 200);

    const rows = (await audit(app, admin)).reverse();
    assert.equal(rows.map((row) => row.action), [
      "admin.created", "login", "reader.created", "reader.invite.created", "reader.password.set", "reader.updated", "reader.removed",
    ]);
    const [byRoot, signedIn, created, invited, chosen, renamed, removed] = rows;
    // The first administrator is made with the root password, which is nobody's account.
    assert.equal([byRoot!.actor.role, byRoot!.actor.via, byRoot!.target], ["root", "root-password", { type: "admin", id: signedIn!.actor.id, name: "ana" }]);
    assert.equal([signedIn!.actor.name, signedIn!.actor.via], ["ana", "password"]);
    assert.equal([created!.actor.name, created!.actor.via, created!.target, created!.details], ["ana", "session", { type: "reader", id: leo.id, name: "leo" }, { email: leo.email }]);
    assert.equal(invited!.target, { type: "reader", id: leo.id, name: "leo" });
    // The reader acts through the link: they have no session yet.
    assert.equal([chosen!.actor.role, chosen!.actor.id, chosen!.actor.via], ["reader", leo.id, "link"]);
    // The row keeps the name the account had before the change, and says what it became.
    assert.equal([renamed!.target!.name, renamed!.details], ["leo", { username: "leonor" }]);
    assert.equal([removed!.target!.id, removed!.target!.name], [leo.id, "leonor"]);
    for (const row of rows) assert(row.at > 1_600_000_000_000 && row.id > 0);
  });

  test("audit: only what changed is written, and a change that changes nothing writes nothing", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    const before = (await audit(app, admin)).length;
    const put = (body: unknown) => app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", body, { cookie: admin }));

    // The form sends every field every time: the same values are not a change.
    assert.equal((await put({ username: "leo", email: leo.email, sources: [] })).status, 200);
    assert.equal((await audit(app, admin)).length, before);
    assert.equal((await put({ username: "leo", email: "leo@other.test", sources: ["does-not-exist"] })).status, 200);
    const [row, ...rest] = await audit(app, admin);
    assert.equal(rest.length, before);
    assert.equal([row!.action, row!.details], ["reader.updated", { email: "leo@other.test" }]);

    assert.equal((await put({})).status, 400);
    assert.equal((await app.fetch("/api/admin/readers/does-not-exist", json("PUT", { username: "nobody" }, { cookie: admin }))).status, 404);
    assert.equal((await app.fetch("/api/admin/readers/does-not-exist", { method: "DELETE", headers: { cookie: admin } })).status, 404);
    assert.equal((await audit(app, admin)).length, before + 1);
  });

  test("audit: a refused sign-in is recorded, without what was typed where the name goes", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    // Someone types their password into the username field.
    const typed = "hunter2-my-real-password";
    assert.equal((await app.fetch("/api/admin/login", json("POST", { username: typed, password: "x" }))).status, 401);
    assert.equal((await app.fetch("/api/admin/login", json("POST", { username: "ANA", password: "wrong-password" }))).status, 401);
    assert.equal((await app.fetch("/api/root/admins", { headers: { "x-root-password": "wrong-root-password" } })).status, 401);

    const rows = await audit(app, admin);
    assert.equal(rows.slice(0, 3).map((row) => [row.action, row.actor.name]), [["root.denied", "root"], ["login.failed", "ana"], ["login.failed", "(unknown)"]]);
    assert.equal(rows[2]!.actor.id, null);
    const text = JSON.stringify(rows);
    for (const secret of [typed, "wrong-password", "wrong-root-password", ROOT, "ana-password"]) assert(!text.includes(secret), secret);
  });

  test("audit: no password, key or link is ever in the log", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await pendingReader(app, admin);
    const cookie = await acceptInvite(app, leo.link, "leo-password");
    const { key, id } = (await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie } })).json()) as { key: string; id: string };
    assert.equal((await app.fetch(`/api/admin/admins`, json("POST", { username: "bia", password: "bia-password" }, { cookie: admin }))).status, 201);
    assert.equal((await app.fetch("/api/reader/props", json("PUT", { props: { theme: "dark", note: "private-note-value" } }, { cookie }))).status, 200);
    assert.equal((await app.fetch(`/api/reader/api-keys/${id}`, { method: "DELETE", headers: { cookie } })).status, 200);
    assert.equal((await app.fetch("/api/reader/logout", { method: "POST", headers: { cookie } })).status, 200);

    const rows = await audit(app, admin);
    assert.equal(rows.slice(0, 5).map((row) => row.action).reverse(), ["api_key.created", "admin.created", "reader.props.updated", "api_key.revoked", "logout"]);
    assert.equal(rows[0]!.actor.name, "leo");
    // Props can be large and personal: the log says which keys, not their values.
    assert.equal(rows[2]!.details, { keys: ["theme", "note"] });
    const text = JSON.stringify(rows);
    for (const secret of [key, leo.link.split("/").at(-1)!, "leo-password", "bia-password", "private-note-value", cookie.split("=")[1]!]) {
      assert(!text.includes(secret), secret);
    }
  });

  test("audit: filters, and a long log read from the newest entry back", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    assert.equal((await app.fetch("/api/reader/login", json("POST", { username: "leo", password: "wrong-password" }))).status, 401);

    // The action filter is exact; the prefix is asked for by name.
    assert.equal((await audit(app, admin, "action=login")).map((row) => row.action), ["login"]);
    assert.equal((await audit(app, admin, "action_prefix=login")).map((row) => row.action), ["login.failed", "login"]);
    assert((await audit(app, admin, "action_prefix=reader.")).every((row) => row.action.startsWith("reader.")));
    assert.equal((await audit(app, admin, "actor=le")).map((row) => row.action), ["login.failed", "reader.password.set"]);
    assert.equal((await audit(app, admin, `target=${leo.id}`)).map((row) => row.action), ["reader.password.set", "reader.invite.created", "reader.created"]);
    assert.equal((await audit(app, admin, `actor_id=${leo.id}`)).length, 2);
    assert.equal((await audit(app, admin, "created_to=2020-01-01")).length, 0);
    assert((await audit(app, admin, "created_from=2020-01-01")).length > 0);
    for (const bad of ["created_from=yesterday", "before=abc"]) {
      assert.equal((await app.fetch(`/api/admin/audit?${bad}`, { headers: { cookie: admin } })).status, 400, bad);
    }

    for (let change = 0; change < 55; change++) {
      await app.fetch("/api/admin/config", json("PUT", { props: { change } }, { cookie: admin }));
    }
    const page = async (query: string): Promise<{ items: { id: number }[]; next_before: number | null }> =>
      (await (await app.fetch(`/api/admin/audit?${query}`, { headers: { cookie: admin } })).json()) as { items: { id: number }[]; next_before: number | null };
    const first = await page("action=platform.props.updated");
    assert.equal([first.items.length, first.next_before], [50, first.items.at(-1)!.id]);
    const second = await page(`action=platform.props.updated&before=${first.next_before}`);
    assert.equal([second.items.length, second.next_before], [5, null]);
    const ids = [...first.items, ...second.items].map((item) => item.id);
    assert.equal(ids, [...ids].sort((a, b) => b - a));
    assert.equal(new Set(ids).size, 55);

    const html = await (await app.fetch("/admin/audit?action=platform.props.updated", { headers: { cookie: admin } })).text();
    assert(html.includes(`before=${first.next_before}`) && html.includes("Platform props changed"));
  });

  test("audit: the log is for administrators only", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    assert.equal((await app.fetch("/api/admin/audit")).status, 401);
    assert.equal((await app.fetch("/api/admin/audit", { headers: { cookie: leo.cookie } })).status, 401);
    assert.equal((await app.fetch("/admin/audit", { headers: { cookie: leo.cookie } })).headers.get("location"), "/admin/");
    // Nothing in the API changes or removes an entry.
    for (const method of ["POST", "PUT", "DELETE"]) {
      assert.equal((await app.fetch("/api/admin/audit", { method, headers: { cookie: admin } })).status, 405, method);
    }
  });
}
