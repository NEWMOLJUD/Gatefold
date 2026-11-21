import type { Tests } from "../deps/testing.ts";
import { ROOT, helpers, secrets } from "./test-helpers.ts";

// What the audit log records besides changes: private sources being opened,
// refusals, exports of the log itself, and how long all of it is kept.
export default function ({ test, assert }: Tests) {
  const { json, cookieOf, createAdmin, pendingReader, createReader, uploadSource, audit } = helpers(assert);
  const root = { "x-root-password": ROOT };

  test("audit: opening a private source is recorded once an hour for each reader and source", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    await uploadSource(app, admin);
    const leo = await createReader(app, admin);
    await app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", { sources: ["example"] }, { cookie: admin }));
    // A page and everything it loads: many requests, one entry.
    for (const path of ["/reader/view/example/", "/reader/view/example/style.css", "/reader/view/example/", "/reader/frame/example"]) {
      const response = await app.fetch(path, { headers: { cookie: leo.cookie } });
      assert.equal(response.status, 200, path);
      await response.arrayBuffer();
    }
    const read = await audit(app, admin, "action=source.read");
    assert.equal(read.map((row) => [row.actor.name, row.actor.via, row.target]), [["leo", "session", { type: "source", id: "example", name: "example" }]]);

    // With an API key it is the same reader and the same hour: still one entry. Another reader gets their own.
    const { key } = (await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string };
    await (await app.fetch("/api/reader/view/example/index.html", { headers: { authorization: `Bearer ${key}` } })).arrayBuffer();
    const mia = await createReader(app, admin, "mia", "mia-password");
    await app.fetch(`/api/admin/readers/${mia.id}`, json("PUT", { sources: ["example"] }, { cookie: admin }));
    await (await app.fetch("/reader/view/example/", { headers: { cookie: mia.cookie } })).arrayBuffer();
    assert.equal((await audit(app, admin, "action=source.read")).map((row) => row.actor.name), ["mia", "leo"]);

    // What everyone can open is not worth an entry.
    assert.equal((await app.fetch("/api/admin/sources/example", json("PUT", { public: true }, { cookie: admin }))).status, 200);
    const noa = await createReader(app, admin, "noa", "noa-password");
    await (await app.fetch("/reader/view/example/", { headers: { cookie: noa.cookie } })).arrayBuffer();
    await (await app.fetch("/reader/view/example/")).arrayBuffer();
    assert.equal((await audit(app, admin, "action=source.read")).length, 2);
  });

  test("audit: a reader asking for a source that is not theirs is recorded, once an hour", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    for (const path of ["/reader/view/payroll/", "/reader/view/payroll/index.html", "/reader/frame/payroll", "/api/reader/view/payroll/x.css"]) {
      assert.equal((await app.fetch(path, { headers: { cookie: leo.cookie } })).status, 403, path);
    }
    assert.equal((await app.fetch("/reader/view/Not_An_Alias/", { headers: { cookie: leo.cookie } })).status, 403);
    const denied = await audit(app, admin, "action=source.denied");
    // The name asked for is written only when it is shaped like a source's name.
    assert.equal(denied.map((row) => [row.actor.name, row.target]), [["leo", { type: "source", id: null, name: "(invalid)" }], ["leo", { type: "source", id: null, name: "payroll" }]]);
    // A visitor who is not signed in is sent to sign in: there is nobody to write down.
    assert.equal((await app.fetch("/reader/view/payroll/")).status, 303);
    assert.equal((await audit(app, admin, "action=source.denied")).length, 2);
  });

  test("audit: links that do not work and requests from other sites are recorded, never with the link", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await pendingReader(app, admin);
    const token = leo.link.split("/").at(-1)!;
    for (const path of ["/api/reader/invite/made-up-link", "/reader/invite/another-made-up-link"]) {
      assert.equal((await app.fetch(path)).status, 404, path);
    }
    assert.equal((await app.fetch("/api/reader/invite/made-up-link", json("POST", { password: "leo-password" }))).status, 404);
    const forged = { origin: "https://fake-site.example" };
    assert.equal((await app.fetch(`/api${leo.link}`, json("POST", { password: "leo-password" }, forged))).status, 403);
    assert.equal((await app.fetch("/api/admin/config", json("PUT", { props: {} }, { cookie: admin, ...forged }))).status, 403);
    assert.equal((await app.fetch("/api/admin/login", json("POST", { username: "ana", password: "ana-password" }, forged))).status, 403);

    const invalid = await audit(app, admin, "action=invite.invalid");
    assert.equal(invalid.map((row) => [row.actor.role, row.actor.via, row.target]), [["visitor", "link", null]]);
    const refused = await audit(app, admin, "action=request.refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.details, { path: "/api/reader/invite/…", origin: "https://fake-site.example" });
    const text = JSON.stringify(await audit(app, admin));
    for (const secret of [token, "made-up-link"]) assert(!text.includes(secret), secret);
  });

  test("audit: the log is exported as a spreadsheet, and the export is itself recorded", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    // A name that a spreadsheet would read as a formula.
    assert.equal((await app.fetch("/api/admin/admins", json("POST", { username: "@sum.a1", password: "danger-password" }, { cookie: admin }))).status, 201);
    assert.equal((await app.fetch("/api/admin/config", json("PUT", { props: { "a \"quoted\" key": 1 } }, { cookie: admin }))).status, 200);
    const before = (await audit(app, admin)).length;

    const file = await app.fetch("/api/admin/audit.csv", { headers: { cookie: admin } });
    assert.equal(file.status, 200);
    assert((file.headers.get("content-type") ?? "").startsWith("text/csv"));
    assert(/^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/.test(file.headers.get("content-disposition") ?? ""));
    assert.equal(file.headers.get("x-gatefold-next-before"), null);
    const lines = (await file.text()).replace(/^﻿/, "").trimEnd().split("\r\n");
    assert.equal(lines[0], "id,at_utc,actor_role,actor_id,actor_name,via,ip,action,target_type,target_id,target_name,details");
    const created = lines.find((line) => line.includes('"admin.created"') && line.includes("@sum.a1")) ?? "";
    assert(created.includes(`"'@sum.a1"`), created);
    assert(/^\d+,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z,"admin",/.test(created), created);
    assert(lines.some((line) => line.includes('"{""keys"":[""a \\""quoted\\"" key""]}"')), "quotes are doubled");

    // The export is one more entry, written after the file was made: it is not in it.
    const after = await audit(app, admin);
    assert.equal(after.length, before + 1);
    assert(!lines.some((line) => line.includes("audit.exported")));
    const filtered = await app.fetch("/api/admin/audit.csv?action=admin.created&actor=ana", { headers: { cookie: admin } });
    assert.equal((await filtered.text()).trimEnd().split("\r\n").length, 2);
    const [second, first] = await audit(app, admin, "action=audit.exported");
    assert.equal([first!.actor.name, first!.details.rows, first!.details.filters], ["ana", lines.length - 1, {}]);
    assert.equal(second!.details, { rows: 1, filters: { action: "admin.created", actor: "ana" } });

    const leo = await createReader(app, admin);
    assert.equal((await app.fetch("/api/admin/audit.csv", { headers: { cookie: leo.cookie } })).status, 401);
    assert((await (await app.fetch("/admin/audit?action=login", { headers: { cookie: admin } })).text()).includes('href="/api/admin/audit.csv?action=login"'));
  });

  test("audit: only root decides how long entries are kept, and old ones leave a trace when they go", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    assert.equal(await (await app.fetch("/api/root/settings", { headers: root })).json(), { audit_retention_days: 180 });
    // An administrator's session is not the root password.
    assert.equal((await app.fetch("/api/root/settings", json("PUT", { audit_retention_days: 365 }, { cookie: admin }))).status, 401);
    for (const days of [89, 0, 3651, 120.5, "365"]) {
      assert.equal((await app.fetch("/api/root/settings", json("PUT", { audit_retention_days: days }, root))).status, 400, String(days));
    }
    assert.equal((await app.fetch("/api/root/settings", json("PUT", { audit_retention_days: 365 }, root))).status, 200);
    assert.equal(await (await app.fetch("/api/root/settings", { headers: root })).json(), { audit_retention_days: 365 });
    const [changed] = await audit(app, admin, "action=settings.updated");
    assert.equal([changed!.actor.role, changed!.details], ["root", { audit_retention_days: 365 }]);
    assert((await (await app.fetch("/admin/audit", { headers: { cookie: admin } })).text()).includes("kept for 365 days"));

    // Nothing is old yet: the daily job removes nothing and says nothing.
    const kept = (await audit(app, admin)).length;
    await app.runCron("2020-01-01T03:17:00Z");
    assert.equal((await audit(app, admin)).length, kept);

    // Decades later every entry of today is past the period. The sessions of today are too.
    await app.runCron("2090-01-01T03:17:00Z");
    const again = cookieOf(await app.fetch("/api/admin/login", json("POST", { username: "ana", password: "ana-password" })));
    const left = await audit(app, again);
    assert.equal(left.map((row) => row.action), ["login", "audit.purged"]);
    const purge = left[1]!;
    assert.equal([purge.actor.role, purge.details.retention_days], ["system", 365]);
    assert(Number(purge.details.rows) >= kept);
    assert.equal(purge.details.older_than, Date.parse("2090-01-01T03:17:00Z") - 365 * 24 * 60 * 60 * 1000);
  });
}
