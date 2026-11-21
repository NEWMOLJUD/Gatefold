import type { Tests } from "../deps/testing.ts";
import { ROOT, helpers, secrets } from "./test-helpers.ts";

// What keeps an account in the right hands: limits on guessing, suspension,
// the last administrator, one's own password, and keys that end.
export default function ({ test, assert }: Tests) {
  const { json, cookieOf, createAdmin, pendingReader, acceptInvite, createReader, audit } = helpers(assert);
  const root = { "x-root-password": ROOT };
  const signIn = (app: Parameters<typeof createAdmin>[0], role: string, username: string, password: string) =>
    app.fetch(`/api/${role}/login`, json("POST", { username, password }));

  test("sign-in: too many wrong passwords block the account for a while, the right one included", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    await createReader(app, admin);
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await signIn(app, "reader", "leo", "wrong-password")).status, 401);
    const blocked = await signIn(app, "reader", "LEO", "leo-password");
    assert.equal([blocked.status, blocked.headers.getSetCookie().length], [429, 0]);
    assert.equal((await signIn(app, "reader", "leo", "wrong-password")).status, 429);
    // Another account, and the same name on the other side, are not touched.
    assert.equal((await signIn(app, "admin", "ana", "ana-password")).status, 200);
    assert.equal((await signIn(app, "admin", "leo", "wrong-password")).status, 401);

    // Every refusal is in the log; the block is there once, not once per attempt.
    assert.equal((await audit(app, admin, "action=login.failed&actor=leo")).length, 5);
    const [block, ...more] = await audit(app, admin, "action=login.blocked");
    assert.equal([block!.actor.name, more.length], ["leo", 0]);
  });

  test("sign-in: a good password takes back the wrong attempts before it", { secrets }, async (app) => {
    await createAdmin(app);
    for (let round = 0; round < 3; round++) {
      for (let attempt = 0; attempt < 4; attempt++) assert.equal((await signIn(app, "admin", "ana", "wrong-password")).status, 401);
      assert.equal((await signIn(app, "admin", "ana", "ana-password")).status, 200, `round ${round}`);
    }
    // Names that are not accounts are counted too, each on its own, and none of them is written down.
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await signIn(app, "admin", "nobody", "wrong-password")).status, 401);
    assert.equal((await signIn(app, "admin", "nobody", "wrong-password")).status, 429);
    assert.equal((await signIn(app, "admin", "somebody-else", "wrong-password")).status, 401);
  });

  test("root: the limit is counted where the attempts come from, and never names the right password", { secrets }, async (app) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await app.fetch("/api/root/admins", { headers: { "x-root-password": "wrong" } })).status, 401);
    }
    for (const password of [ROOT, "wrong"]) assert.equal((await app.fetch("/api/root/admins", { headers: { "x-root-password": password } })).status, 429);
    assert.equal((await app.fetch("/api/root/settings", { headers: root })).status, 429);
  });

  test("root: a short root password turns root access off instead of leaving it weak", { secrets: { ...secrets, GATEFOLD_ROOT_PASSWORD: "short-root" } }, async (app) => {
    const refused = await app.fetch("/api/root/admins", { headers: { "x-root-password": "short-root" } });
    assert.equal(refused.status, 503);
    assert(((await refused.json()) as { error: string }).error.includes("32"));
    assert.equal((await app.fetch("/root/setup")).status, 200);
  });

  test("suspension: the account is kept out everywhere and gets everything back when reactivated", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    const { key } = (await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string };
    const act = (action: string, id = leo.id, kind = "readers") => app.fetch(`/api/admin/${kind}/${id}/${action}`, { method: "POST", headers: { cookie: admin } });

    assert.equal((await act("suspend")).status, 200);
    assert.equal((await act("suspend")).status, 200);
    assert.equal((await app.fetch("/api/reader/me", { headers: { cookie: leo.cookie } })).status, 401);
    assert.equal((await app.fetch("/api/reader/me", { headers: { authorization: `Bearer ${key}` } })).status, 401);
    // The reason is said only to whoever has the password.
    const right = await signIn(app, "reader", "leo", "leo-password");
    assert.equal([right.status, ((await right.json()) as { error: string }).error.includes("suspended")], [403, true]);
    assert.equal(((await (await signIn(app, "reader", "leo", "wrong-password")).json()) as { error: string }).error, "Invalid username or password.");
    // A link issued while suspended waits for the reactivation.
    const issued = (await (await app.fetch(`/api/admin/readers/${leo.id}/invite`, { method: "POST", headers: { cookie: admin } })).json()) as { url: string };
    const link = new URL(issued.url).pathname;
    assert.equal((await app.fetch(`/api${link}`)).status, 404);
    const listed = (await (await app.fetch("/api/admin/readers", { headers: { cookie: admin } })).json()) as { items: { suspended: boolean }[] };
    assert.equal(listed.items[0]!.suspended, true);
    assert((await (await app.fetch(`/admin/edit-reader?reader-id=${leo.id}`, { headers: { cookie: admin } })).text()).includes("is suspended"));

    assert.equal((await act("reactivate")).status, 200);
    assert.equal((await app.fetch("/api/reader/me", { headers: { authorization: `Bearer ${key}` } })).status, 200);
    // The sessions ended for good: signing in again is what brings one back.
    assert.equal((await app.fetch("/api/reader/me", { headers: { cookie: leo.cookie } })).status, 401);
    assert.equal((await signIn(app, "reader", "leo", "leo-password")).status, 200);
    assert.equal((await app.fetch(`/api${link}`)).status, 200);
    assert.equal((await act("suspend", "does-not-exist")).status, 404);
    assert.equal((await act("reactivate", "does-not-exist")).status, 404);

    const rows = await audit(app, admin, `target=${leo.id}&action_prefix=reader.`);
    // Suspending twice was one change, so it is one entry.
    assert.equal(rows.map((row) => row.action).filter((action) => ["reader.suspended", "reader.reactivated"].includes(action)), ["reader.reactivated", "reader.suspended"]);
  });

  test("the last administrator who can sign in cannot be removed or suspended, except by root", { secrets }, async (app) => {
    const ana = await createAdmin(app);
    const me = ((await (await app.fetch("/api/admin/me", { headers: { cookie: ana } })).json()) as { id: string }).id;
    const act = (method: string, path: string, cookie = ana) => app.fetch(`/api/admin/admins/${path}`, { method, headers: { cookie } });
    for (const refused of [await act("DELETE", me), await act("POST", `${me}/suspend`)]) {
      assert.equal(refused.status, 409);
      assert(((await refused.json()) as { error: string }).error.includes("last active administrator"));
    }
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie: ana } })).status, 200);

    // A second administrator who is suspended does not count as one who can sign in.
    const bia = await createAdmin(app, "bia", "bia-password");
    const biaId = ((await (await app.fetch("/api/admin/me", { headers: { cookie: bia } })).json()) as { id: string }).id;
    assert.equal((await act("POST", `${biaId}/suspend`)).status, 200);
    assert.equal((await act("DELETE", me)).status, 409);
    assert.equal((await act("POST", `${biaId}/reactivate`)).status, 200);
    const biaAgain = cookieOf(await signIn(app, "admin", "bia", "bia-password"));
    // With two, one may go, by their own hand too.
    assert.equal((await act("POST", `${me}/suspend`, biaAgain)).status, 200);
    assert.equal((await act("DELETE", biaId, biaAgain)).status, 409);
    // Root is not held by the rule, and is the way back in.
    assert.equal((await app.fetch(`/api/root/admins/${me}/reactivate`, { method: "POST", headers: root })).status, 200);
    assert.equal((await app.fetch(`/api/root/admins/${biaId}`, { method: "DELETE", headers: root })).status, 200);
    assert.equal((await app.fetch(`/api/root/admins/${me}`, { method: "DELETE", headers: root })).status, 200);
    assert.equal(((await (await app.fetch("/api/root/admins", { headers: root })).json()) as { items: unknown[] }).items.length, 0);
  });

  test("one's own password: changed with the current one, and it signs the other sessions out", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const elsewhere = cookieOf(await signIn(app, "admin", "ana", "ana-password"));
    const change = (body: unknown, headers: Record<string, string> = { cookie: admin }) => app.fetch("/api/admin/password", json("PUT", body, headers));

    assert.equal((await change({ current_password: "not-my-password", new_password: "ana-next-password" })).status, 403);
    assert.equal((await change({ current_password: "ana-password", new_password: "short" })).status, 400);
    assert.equal((await change({ current_password: "ana-password", new_password: "ana-password" })).status, 400);
    assert.equal((await change({ current_password: "ana-password", new_password: "ana-next-password" }, {})).status, 401);
    const { key } = (await (await app.fetch("/api/admin/api-keys", { method: "POST", headers: { cookie: admin } })).json()) as { key: string };
    assert.equal((await change({ current_password: "ana-password", new_password: "ana-next-password" }, { authorization: `Bearer ${key}` })).status, 403);

    assert.equal((await change({ current_password: "ana-password", new_password: "ana-next-password" })).status, 200);
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie: admin } })).status, 200);
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie: elsewhere } })).status, 401);
    assert.equal((await signIn(app, "admin", "ana", "ana-password")).status, 401);
    assert.equal((await signIn(app, "admin", "ana", "ana-next-password")).status, 200);
    const [row] = await audit(app, admin, "action=password.changed");
    assert.equal([row!.actor.name, row!.target!.name], ["ana", "ana"]);
    assert(!JSON.stringify(await audit(app, admin)).includes("ana-next-password"));

    // The page does the same, for a reader too.
    const leo = await createReader(app, admin);
    const form = (fields: Record<string, string>) => app.fetch("/reader/account", { method: "POST", headers: { cookie: leo.cookie }, body: new URLSearchParams(fields) });
    assert(((await form({ current_password: "leo-password", new_password: "leo-next-password", confirm: "leo-other-password" })).headers.get("location") ?? "").includes("error="));
    assert(((await form({ current_password: "leo-password", new_password: "leo-next-password", confirm: "leo-next-password" })).headers.get("location") ?? "").includes("ok="));
    assert.equal((await signIn(app, "reader", "leo", "leo-next-password")).status, 200);

    // Guessing the current password through a stolen session runs out of attempts.
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await change({ current_password: `guess-number-${attempt}`, new_password: "x".repeat(12) })).status, 403);
    assert.equal((await change({ current_password: "ana-next-password", new_password: "ana-third-password" })).status, 429);
  });

  test("an administrator's password is set by themselves or by root, never by another administrator", { secrets }, async (app) => {
    const ana = await createAdmin(app);
    const bia = await createAdmin(app, "bia", "bia-password");
    const biaId = ((await (await app.fetch("/api/admin/me", { headers: { cookie: bia } })).json()) as { id: string }).id;
    const refused = await app.fetch(`/api/admin/admins/${biaId}`, json("PUT", { password: "taken-over-password" }, { cookie: ana }));
    assert.equal(refused.status, 403);
    assert.equal((await signIn(app, "admin", "bia", "bia-password")).status, 200);
    // Renaming is still an administrator's job.
    assert.equal((await app.fetch(`/api/admin/admins/${biaId}`, json("PUT", { username: "beatriz" }, { cookie: ana }))).status, 200);

    assert.equal((await app.fetch(`/api/root/admins/${biaId}`, json("PUT", { password: "short" }, root))).status, 400);
    assert.equal((await app.fetch(`/api/root/admins/${biaId}`, json("PUT", { password: "set-by-root-password" }, root))).status, 200);
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie: bia } })).status, 401);
    assert.equal((await signIn(app, "admin", "beatriz", "set-by-root-password")).status, 200);
    const [row] = await audit(app, ana, `target=${biaId}&action=admin.updated`);
    assert.equal([row!.actor.role, row!.details], ["root", { password: "changed" }]);
    assert.equal((await app.fetch("/api/root/admins/does-not-exist", json("PUT", { password: "set-by-root-password" }, root))).status, 404);
  });

  test("API keys: a name to tell them apart, an end, and when they were last used", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const create = (body?: unknown) => app.fetch("/api/admin/api-keys", body === undefined ? { method: "POST", headers: { cookie: admin } } : json("POST", body, { cookie: admin }));
    for (const bad of [{ expires_in_days: 0 }, { expires_in_days: 3651 }, { expires_in_days: 1.5 }, { name: "x".repeat(61) }, { name: 7 }]) {
      assert.equal((await create(bad)).status, 400, JSON.stringify(bad));
    }
    const plain = (await (await create()).json()) as { key: string; name: string | null; expires_at: number | null; last_used_at: number | null };
    assert.equal([plain.name, plain.expires_at, plain.last_used_at], [null, null, null]);
    const named = (await (await create({ name: " backup script ", expires_in_days: 30 })).json()) as { id: string; key: string; name: string; created_at: number; expires_at: number };
    assert.equal([named.name, named.expires_at - named.created_at], ["backup script", 30 * 24 * 60 * 60 * 1000]);

    assert.equal((await app.fetch("/api/admin/me", { headers: { authorization: `Bearer ${named.key}` } })).status, 200);
    const list = (await (await app.fetch("/api/admin/api-keys", { headers: { cookie: admin } })).json()) as { items: { id: string; name: string | null; last_used_at: number | null }[] };
    const used = list.items.find((key) => key.id === named.id)!;
    assert(used.last_used_at !== null && used.last_used_at >= named.created_at);
    assert.equal(list.items.find((key) => key.id !== named.id)!.last_used_at, null);

    const page = await (await app.fetch("/admin/api-keys", { headers: { cookie: admin } })).text();
    assert(page.includes("backup script") && page.includes('name="expires_in_days"'));
    const generated = await (await app.fetch("/admin/api-keys", { method: "POST", headers: { cookie: admin }, body: new URLSearchParams({ action: "create", name: "from the page", expires_in_days: "" }) })).text();
    assert(/cn_a_[A-Za-z0-9_-]+/.test(generated));
    const [row] = await audit(app, admin, "action=api_key.created");
    assert.equal(row!.target!.name, "from the page");
  });

  test("API keys: a key with an end works until then, for a reader too", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await pendingReader(app, admin);
    const cookie = await acceptInvite(app, leo.link, "leo-password");
    const { key, expires_at } = (await (await app.fetch("/api/reader/api-keys", json("POST", { expires_in_days: 1 }, { cookie }))).json()) as { key: string; expires_at: number };
    // The end is compared with the clock each time the key is used; these tests cannot move the clock past it.
    assert(expires_at > Date.now());
    assert.equal((await app.fetch("/api/reader/sources", { headers: { authorization: `Bearer ${key}` } })).status, 200);
    assert((await (await app.fetch("/reader/api-keys", { headers: { cookie } })).text()).includes("Last used (UTC)"));
  });
}
