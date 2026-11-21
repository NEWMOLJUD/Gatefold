import type { App, Tests } from "../deps/testing.ts";
import { MFA_STEP_MS, mfaCode } from "./security.ts";
import { ROOT, helpers, secrets } from "./test-helpers.ts";

// Two-step verification: optional, turned on by each administrator for their
// own account, and asked for at sign-in only from those who turned it on.
// The readers' side, and making it required of them, is in reader-two-step.test.ts.
export default function ({ test, assert }: Tests) {
  const { json, cookieOf, createAdmin, audit } = helpers(assert);
  const root = { "x-root-password": ROOT };
  const signIn = (app: App, username: string, password: string, code?: string) =>
    app.fetch("/api/admin/login", json("POST", { username, password, ...(code === undefined ? {} : { code }) }));
  /** The code an authenticator app would show now, or `ahead` steps of 30 seconds from now. */
  const codeNow = (secret: string, ahead = 0) => mfaCode(secret, Math.floor(Date.now() / MFA_STEP_MS) + ahead);
  const post = (app: App, path: string, cookie: string, body: unknown = {}) => app.fetch(`/api/admin/two-step${path}`, json("POST", body, { cookie }));
  const status = async (app: App, cookie: string) => (await app.fetch("/api/admin/two-step", { headers: { cookie } })).json();

  test("two-step: the codes are the ones every authenticator app makes (RFC 6238)", async () => {
    // "12345678901234567890", the key of the standard's own examples.
    const key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    assert.equal([await mfaCode(key, 1), await mfaCode(key, 37037036), await mfaCode(key, 66666666)], ["287082", "081804", "279037"]);
  });

  test("two-step: an administrator turns it on for themselves, and only they are asked for a code", { secrets }, async (app) => {
    const ana = await createAdmin(app);
    const bia = await createAdmin(app, "bia", "bia-password");
    const elsewhere = cookieOf(await signIn(app, "bia", "bia-password"));
    assert.equal(await status(app, bia), { enabled: false, enabled_at: null, pending: false });

    // Starting asks for the password; until a code confirms it, nothing changes at sign-in.
    assert.equal((await post(app, "/setup", bia, { current_password: "wrong-password" })).status, 403);
    assert.equal((await post(app, "/confirm", bia, { code: "123456" })).status, 409);
    const setup = await post(app, "/setup", bia, { current_password: "bia-password" });
    const { secret, url } = (await setup.json()) as { secret: string; url: string };
    assert.equal([setup.status, /^[A-Z2-7]{32}$/.test(secret), url.startsWith("otpauth://totp/"), url.includes(`secret=${secret}`)], [200, true, true, true]);
    assert.equal(await status(app, bia), { enabled: false, enabled_at: null, pending: true });
    assert.equal((await signIn(app, "bia", "bia-password")).status, 200);
    const page = await (await app.fetch("/admin/account", { headers: { cookie: bia } })).text();
    assert(page.includes(secret) && page.includes("finish the setup"));

    const wrong = (await codeNow(secret)) === "000000" ? "000001" : "000000";
    assert.equal((await post(app, "/confirm", bia, { code: wrong })).status, 400);
    assert.equal((await post(app, "/confirm", bia, { code: await codeNow(secret) })).status, 200);
    const on = (await status(app, bia)) as { enabled: boolean; pending: boolean };
    assert.equal([on.enabled, on.pending], [true, false]);
    // The session that turned it on stays; the one opened elsewhere without a code is gone; the key is not shown again.
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie: elsewhere } })).status, 401);
    assert(!(await (await app.fetch("/admin/account", { headers: { cookie: bia } })).text()).includes(secret));
    assert.equal((await post(app, "/setup", bia, { current_password: "bia-password" })).status, 409);

    // Bia now needs the code; Ana, who never turned it on, signs in as before.
    const missing = await signIn(app, "bia", "bia-password");
    assert.equal([missing.status, missing.headers.getSetCookie().length], [401, 0]);
    assert(((await missing.json()) as { error: string }).error.includes("two-step"));
    assert.equal((await signIn(app, "bia", "bia-password", wrong)).status, 401);
    assert.equal((await signIn(app, "bia", "wrong-password", await codeNow(secret, 1))).status, 401);
    // The code that confirmed the setup was used by it: the next one signs in, once.
    assert.equal((await signIn(app, "bia", "bia-password", await codeNow(secret))).status, 401);
    const next = await codeNow(secret, 1);
    const signed = await signIn(app, "bia", "bia-password", ` ${next.slice(0, 3)} ${next.slice(3)} `);
    assert.equal(signed.status, 200);
    assert.equal((await signIn(app, "bia", "bia-password", next)).status, 401);
    assert.equal((await signIn(app, "ana", "ana-password")).status, 200);

    // The others see who uses it, and nothing else about it.
    const { items } = (await (await app.fetch("/api/admin/admins", { headers: { cookie: ana } })).json()) as { items: Record<string, unknown>[] };
    assert.equal(items.map((item) => [item.username, item.two_step]), [["ana", false], ["bia", true]]);
    assert(items.every((item) => !("mfa_secret" in item) && !JSON.stringify(item).includes(secret)));

    const actions = (await audit(app, ana, "actor=bia")).map((row) => row.action);
    for (const action of ["mfa.setup", "mfa.enabled"]) assert(actions.includes(action), action);
    const refused = await audit(app, ana, "action=login.failed&actor=bia");
    assert.equal(refused.filter((row) => row.details.reason === "wrong code").length, 3);
    assert(!JSON.stringify(await audit(app, ana)).includes(secret));
  });

  test("two-step: turning it off takes the password, a session and not a key; root turns it off for a lost phone", { secrets }, async (app) => {
    const ana = await createAdmin(app);
    const { secret } = (await (await post(app, "/setup", ana, { current_password: "ana-password" })).json()) as { secret: string };
    // A setup never confirmed is given up without the password, and a new one starts with a new key.
    assert.equal((await post(app, "/disable", ana)).status, 200);
    assert.equal((await post(app, "/disable", ana)).status, 409);
    const again = (await (await post(app, "/setup", ana, { current_password: "ana-password" })).json()) as { secret: string };
    assert(again.secret !== secret);
    assert.equal((await post(app, "/confirm", ana, { code: await codeNow(secret) })).status, 400);
    assert.equal((await post(app, "/confirm", ana, { code: await codeNow(again.secret) })).status, 200);

    const { key } = (await (await app.fetch("/api/admin/api-keys", { method: "POST", headers: { cookie: ana } })).json()) as { key: string };
    const bearer = { authorization: `Bearer ${key}` };
    // A key keeps working without codes, and cannot touch the two-step verification.
    assert.equal((await app.fetch("/api/admin/me", { headers: bearer })).status, 200);
    assert.equal((await app.fetch("/api/admin/two-step/disable", json("POST", { current_password: "ana-password" }, bearer))).status, 403);
    assert.equal((await post(app, "/disable", ana, { current_password: "wrong-password" })).status, 403);
    assert.equal((await post(app, "/disable", ana)).status, 403);
    assert.equal((await signIn(app, "ana", "ana-password")).status, 401);

    // Another administrator cannot turn it off; root can, and the password alone signs in again.
    const bia = await createAdmin(app, "bia", "bia-password");
    const { items } = (await (await app.fetch("/api/root/admins", { headers: root })).json()) as { items: { id: string; username: string; two_step: boolean }[] };
    const anaId = items.find((item) => item.username === "ana")!.id;
    assert.equal(items.find((item) => item.username === "ana")!.two_step, true);
    assert.equal((await app.fetch(`/api/root/admins/${anaId}/two-step`, { method: "DELETE", headers: { cookie: bia } })).status, 401);
    assert.equal((await app.fetch(`/api/root/admins/${anaId}/two-step`, { method: "DELETE", headers: root })).status, 200);
    assert.equal((await app.fetch("/api/root/admins/does-not-exist/two-step", { method: "DELETE", headers: root })).status, 404);
    assert.equal((await signIn(app, "ana", "ana-password")).status, 200);
    assert.equal(await status(app, ana), { enabled: false, enabled_at: null, pending: false });

    // On again, and off by Ana herself with her password.
    const third = (await (await post(app, "/setup", ana, { current_password: "ana-password" })).json()) as { secret: string };
    assert.equal((await post(app, "/confirm", ana, { code: await codeNow(third.secret) })).status, 200);
    assert.equal((await post(app, "/disable", ana, { current_password: "ana-password" })).status, 200);
    assert.equal((await signIn(app, "ana", "ana-password")).status, 200);

    const off = await audit(app, bia, "action=mfa.disabled");
    assert.equal(off.map((row) => [row.actor.role, row.target?.name, row.details]), [["admin", "ana", {}], ["root", "ana", {}], ["admin", "ana", { setup: "cancelled" }]]);
  });

  test("two-step: the pages offer it on Your account and ask for the code at both sign-ins", { secrets }, async (app) => {
    const ana = await createAdmin(app);
    assert((await (await app.fetch("/admin/")).text()).includes('name="code"'));
    assert((await (await app.fetch("/reader/")).text()).includes('name="code"'));
    assert((await (await app.fetch("/admin/account", { headers: { cookie: ana } })).text()).includes("Two-step verification"));
    const form = (fields: Record<string, string>) => app.fetch("/admin/account", {
      method: "POST", headers: { cookie: ana, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
    });
    const started = await form({ action: "two-step-start", current_password: "ana-password" });
    assert.equal([started.status, (started.headers.get("location") ?? "").startsWith("/admin/account?ok=")], [303, true]);
    const secret = /id="two-step-key">([A-Z2-7]{32})</.exec(await (await app.fetch("/admin/account", { headers: { cookie: ana } })).text())?.[1] ?? "";
    assert.equal((await form({ action: "two-step-confirm", code: await codeNow(secret) })).status, 303);
    assert.equal(((await status(app, ana)) as { enabled: boolean }).enabled, true);
    // The password form of the same page still changes the password, and only that.
    assert.equal((await form({ current_password: "ana-password", new_password: "another-password", confirm: "another-password" })).status, 303);
    assert.equal(((await status(app, ana)) as { enabled: boolean }).enabled, true);
  });
}
