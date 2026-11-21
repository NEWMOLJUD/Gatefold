import type { Tests } from "../deps/testing.ts";
import { helpers, secrets } from "./test-helpers.ts";

// The access link: an administrator creates a reader with a name and an email,
// and the reader chooses their own password through a link that works once.
export default function ({ test, assert }: Tests) {
  const { json, cookieOf, createAdmin, invitePath, pendingReader, acceptInvite, createReader } = helpers(assert);

  test("invite: nobody signs in as a reader who has not chosen a password", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await pendingReader(app, admin);
    for (const password of ["", "leo-password", "pbkdf2$1$$"]) {
      assert.equal((await app.fetch("/api/reader/login", json("POST", { username: "leo", password }))).status, 401, password);
    }
    const detail = (await (await app.fetch(`/api/admin/readers/${leo.id}`, { headers: { cookie: admin } })).json()) as Record<string, unknown>;
    assert.equal([detail.pending, detail.email, detail.invite !== null], [true, "leo@example.test", true]);
    // What is stored about the link is when it was issued and when it ends, never the link.
    assert(!JSON.stringify(detail).includes(leo.link.split("/").at(-1)!));
  });

  test("invite: the link says whose it is, works once and signs the reader in", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await pendingReader(app, admin);

    // Looking at the link does not use it up: mail scanners and previews open links.
    for (let look = 0; look < 2; look++) {
      const seen = await app.fetch(`/api${leo.link}`);
      assert.equal(seen.status, 200);
      const body = (await seen.json()) as Record<string, unknown>;
      assert.equal(Object.keys(body).sort(), ["expires_at", "username"]);
      assert.equal(body.username, "leo");
    }
    // A refused password leaves the link as it was.
    assert.equal((await app.fetch(`/api${leo.link}`, json("POST", { password: "short" }))).status, 400);
    assert.equal((await app.fetch(`/api${leo.link}`, json("POST", { password: "leo-password" }, { origin: "https://fake-site.example" }))).status, 403);

    const cookie = await acceptInvite(app, leo.link, "leo-password");
    assert.equal(((await (await app.fetch("/api/reader/me", { headers: { cookie } })).json()) as { username: string }).username, "leo");
    assert.equal((await app.fetch("/api/reader/login", json("POST", { username: "leo", password: "leo-password" }))).status, 200);

    // Used: it is gone for everyone.
    assert.equal((await app.fetch(`/api${leo.link}`)).status, 404);
    assert.equal((await app.fetch(`/api${leo.link}`, json("POST", { password: "another-password" }))).status, 404);
    assert.equal((await app.fetch("/api/reader/login", json("POST", { username: "leo", password: "another-password" }))).status, 401);
    const detail = (await (await app.fetch(`/api/admin/readers/${leo.id}`, { headers: { cookie: admin } })).json()) as Record<string, unknown>;
    assert.equal([detail.pending, detail.invite], [false, null]);
  });

  test("invite: a new link replaces the one before, and the old password works until it is used", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await pendingReader(app, admin);
    const issue = async (): Promise<string> => {
      const issued = await app.fetch(`/api/admin/readers/${leo.id}/invite`, { method: "POST", headers: { cookie: admin } });
      assert.equal(issued.status, 201);
      return invitePath(((await issued.json()) as { url: string }).url);
    };
    const second = await issue();
    assert(second !== leo.link);
    assert.equal((await app.fetch(`/api${leo.link}`)).status, 404);
    await acceptInvite(app, second, "leo-password");

    // A link for a reader who already has a password: nothing changes until it is used.
    const third = await issue();
    assert.equal((await app.fetch("/api/reader/login", json("POST", { username: "leo", password: "leo-password" }))).status, 200);
    await acceptInvite(app, third, "leo-next-password");
    assert.equal((await app.fetch("/api/reader/login", json("POST", { username: "leo", password: "leo-password" }))).status, 401);
    assert.equal((await app.fetch("/api/reader/login", json("POST", { username: "leo", password: "leo-next-password" }))).status, 200);

    assert.equal((await app.fetch("/api/admin/readers/does-not-exist/invite", { method: "POST", headers: { cookie: admin } })).status, 404);
  });

  test("invite: revoked, expired or made up, a link gives the same answer", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await pendingReader(app, admin);
    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}/invite`, { method: "DELETE", headers: { cookie: admin } })).status, 200);
    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}/invite`, { method: "DELETE", headers: { cookie: admin } })).status, 404);
    const revoked = await app.fetch(`/api${leo.link}`);
    const madeUp = await app.fetch("/api/reader/invite/not-a-real-link");
    assert.equal([revoked.status, madeUp.status], [404, 404]);
    assert.equal(await revoked.json(), await madeUp.json());

    // Removing the reader takes the link with them.
    const noa = await pendingReader(app, admin, "noa");
    assert.equal((await app.fetch(`/api/admin/readers/${noa.id}`, { method: "DELETE", headers: { cookie: admin } })).status, 200);
    assert.equal((await app.fetch(`/api${noa.link}`, json("POST", { password: "noa-password" }))).status, 404);

    // The scheduled cleanup removes the links that ran out of time.
    const mia = await pendingReader(app, admin, "mia");
    await app.runCron("2020-01-01T00:17:00Z");
    assert.equal((await app.fetch(`/api${mia.link}`)).status, 200);
    await app.runCron("2090-01-01T00:17:00Z");
    assert.equal((await app.fetch(`/api${mia.link}`)).status, 404);
  });

  test("invite: the pages show the link once and let the reader create the password", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const added = await app.fetch("/admin/create-reader", { method: "POST", headers: { cookie: admin }, body: new URLSearchParams({ username: "leo", email: "Leo@Example.test" }) });
    assert.equal(added.status, 200);
    const link = /\/reader\/invite\/[A-Za-z0-9_-]+/.exec(await added.text())?.[0] ?? "";
    assert(link !== "", "the page that adds a reader shows the link");
    const token = link.split("/").at(-1)!;

    const list = (await (await app.fetch("/api/admin/readers", { headers: { cookie: admin } })).json()) as { items: { id: string; email: string; pending: boolean }[] };
    assert.equal([list.items[0]!.email, list.items[0]!.pending], ["leo@example.test", true]);
    const edit = `/admin/edit-reader?reader-id=${list.items[0]!.id}`;
    for (const path of [edit, "/admin/list-readers", "/admin/audit"]) {
      assert(!(await (await app.fetch(path, { headers: { cookie: admin } })).text()).includes(token), `${path} shows the link again`);
    }

    const form = await app.fetch(link);
    assert.equal(form.status, 200);
    assert((await form.text()).includes('value="leo"'));
    const mismatch = await app.fetch(link, { method: "POST", body: new URLSearchParams({ password: "leo-password", confirm: "leo-passw0rd" }) });
    assert((mismatch.headers.get("location") ?? "").startsWith(`${link}?error=`));
    const created = await app.fetch(link, { method: "POST", body: new URLSearchParams({ password: "leo-password", confirm: "leo-password" }) });
    assert.equal(created.headers.get("location"), "/reader/home");
    assert.equal((await app.fetch("/reader/home", { headers: { cookie: cookieOf(created) } })).status, 200);
    assert.equal((await app.fetch(link)).status, 404);

    // The reader's page can issue and revoke links too.
    const again = await app.fetch(edit, { method: "POST", headers: { cookie: admin }, body: new URLSearchParams({ action: "invite" }) });
    assert(/\/reader\/invite\/[A-Za-z0-9_-]+/.test(await again.text()));
    const revoked = await app.fetch(edit, { method: "POST", headers: { cookie: admin }, body: new URLSearchParams({ action: "revoke-invite" }) });
    assert((revoked.headers.get("location") ?? "").includes("ok="));
  });

  test("invite: only an administrator issues links", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    for (const init of [{ method: "POST" }, { method: "POST", headers: { cookie: leo.cookie } }]) {
      assert.equal((await app.fetch(`/api/admin/readers/${leo.id}/invite`, init)).status, 401);
    }
  });
}
