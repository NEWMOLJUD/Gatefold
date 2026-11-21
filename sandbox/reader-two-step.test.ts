import type { App, Tests } from "../deps/testing.ts";
import { MFA_STEP_MS, mfaCode } from "./security.ts";
import { helpers, secrets } from "./test-helpers.ts";

// Two-step verification for readers: each one can turn it on, and an
// administrator can require it of all of them. A reader who then has not set
// it up signs in and can do one thing only: set it up.
export default function ({ test, assert }: Tests) {
  const { json, cookieOf, createAdmin, createReader, pendingReader, uploadSource, audit } = helpers(assert);
  const signIn = (app: App, username: string, password: string, code?: string) =>
    app.fetch("/api/reader/login", json("POST", { username, password, ...(code === undefined ? {} : { code }) }));
  const codeNow = (secret: string, ahead = 0) => mfaCode(secret, Math.floor(Date.now() / MFA_STEP_MS) + ahead);
  const post = (app: App, path: string, cookie: string, body: unknown = {}) => app.fetch(`/api/reader/two-step${path}`, json("POST", body, { cookie }));
  const get = (app: App, path: string, headers: Record<string, string>) => app.fetch(path, { headers, redirect: "manual" });
  const require = (app: App, admin: string, required: boolean) => app.fetch("/api/admin/reader-settings", json("PUT", { two_step_required: required }, { cookie: admin }));
  /** Turns it on for the signed-in reader and returns the key of their authenticator app. */
  const turnOn = async (app: App, cookie: string, password: string): Promise<string> => {
    const { secret } = (await (await post(app, "/setup", cookie, { current_password: password })).json()) as { secret: string };
    assert.equal((await post(app, "/confirm", cookie, { code: await codeNow(secret) })).status, 200);
    return secret;
  };

  test("reader two-step: a reader turns it on for themselves, and an administrator turns it off for a lost phone", { secrets }, async (app) => {
    const ana = await createAdmin(app);
    const leo = await createReader(app, ana);
    assert.equal(await (await get(app, "/api/reader/two-step", { cookie: leo.cookie })).json(), { enabled: false, enabled_at: null, pending: false, required: false });
    const secret = await turnOn(app, leo.cookie, "leo-password");

    const missing = await signIn(app, "leo", "leo-password");
    assert.equal([missing.status, missing.headers.getSetCookie().length], [401, 0]);
    // The code that confirmed the setup was used by it: the next one signs in.
    assert.equal((await signIn(app, "leo", "leo-password", await codeNow(secret))).status, 401);
    assert.equal((await signIn(app, "leo", "leo-password", await codeNow(secret, 1))).status, 200);

    // The administrators see who uses it, and never the key.
    const listed = await (await get(app, "/api/admin/readers", { cookie: ana })).text();
    assert.equal((JSON.parse(listed) as { items: { two_step: boolean }[] }).items[0]!.two_step, true);
    assert(!listed.includes(secret) && !listed.includes("mfa_secret"));
    assert((await (await get(app, `/admin/edit-reader?reader-id=${leo.id}`, { cookie: ana })).text()).includes("reset-two-step"));

    // A reader cannot turn it off for another; an administrator can, and the password alone signs in again.
    const mia = await createReader(app, ana, "mia", "mia-password");
    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}/two-step`, { method: "DELETE", headers: { cookie: mia.cookie } })).status, 401);
    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}/two-step`, { method: "DELETE", headers: { cookie: ana } })).status, 200);
    assert.equal((await app.fetch("/api/admin/readers/does-not-exist/two-step", { method: "DELETE", headers: { cookie: ana } })).status, 404);
    assert.equal((await signIn(app, "leo", "leo-password")).status, 200);
    // An administrator's own stays with root.
    const { items } = (await (await get(app, "/api/admin/admins", { cookie: ana })).json()) as { items: { id: string }[] };
    assert.equal((await app.fetch(`/api/admin/admins/${items[0]!.id}/two-step`, { method: "DELETE", headers: { cookie: ana } })).status, 404);

    const off = await audit(app, ana, "action=mfa.disabled");
    assert.equal(off.map((row) => [row.actor.role, row.target?.type, row.target?.name]), [["admin", "reader", "leo"]]);
  });

  test("reader two-step: once required, a reader without it can only set it up", { secrets }, async (app) => {
    const ana = await createAdmin(app);
    await uploadSource(app, ana);
    await uploadSource(app, ana, { alias: "open", public: true });
    const leo = await createReader(app, ana);
    const mia = await createReader(app, ana, "mia", "mia-password");
    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", { sources: ["example"] }, { cookie: ana }))).status, 200);
    const miaSecret = await turnOn(app, mia.cookie, "mia-password");
    const { key } = (await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string };
    const bearer = { authorization: `Bearer ${key}` };
    assert.equal((await get(app, "/api/reader/view/example/", bearer)).status, 200);

    // Only an administrator decides it, and only with true or false.
    assert.equal((await app.fetch("/api/admin/reader-settings", json("PUT", { two_step_required: true }, { cookie: leo.cookie }))).status, 401);
    assert.equal((await app.fetch("/api/admin/reader-settings", json("PUT", { two_step_required: "yes" }, { cookie: ana }))).status, 400);
    assert.equal(await (await get(app, "/api/admin/reader-settings", { cookie: ana })).json(), { two_step_required: false, readers_without_two_step: 1 });
    assert.equal((await require(app, ana, true)).status, 200);
    assert.equal(await (await get(app, "/api/admin/reader-settings", { cookie: ana })).json(), { two_step_required: true, readers_without_two_step: 1 });

    // Leo was signed in: from the next request on, every page sends him to Your account, and the API refuses him.
    for (const path of ["/reader/home", "/reader/config", "/reader/api-keys", "/reader/view/example/", "/reader/view/open/", "/reader/frame/example", "/reader/"]) {
      const response = await get(app, path, { cookie: leo.cookie });
      assert.equal([response.status, response.headers.get("location")], [303, "/reader/account"], path);
    }
    for (const path of ["/api/reader/sources", "/api/reader/props", "/api/reader/api-keys", "/api/reader/view/example/", "/api/reader/view/open/"]) {
      assert.equal((await get(app, path, { cookie: leo.cookie })).status, 403, path);
      // A key made before is no way around it.
      assert.equal((await get(app, path, bearer)).status, 403, path);
    }
    assert.equal((await app.fetch("/api/reader/props", json("PUT", { props: { theme: "dark" } }, { cookie: leo.cookie }))).status, 403);
    // Nothing was read in his name: the log has the one opening from before the rule.
    assert.equal((await audit(app, ana, "action=source.read")).length, 1);
    // Mia, who has it on, and a visitor reading a public source, notice nothing.
    assert.equal((await get(app, "/api/reader/sources", { cookie: mia.cookie })).status, 200);
    assert.equal((await get(app, "/reader/view/open/", {})).status, 200);

    // Signing in works and says what is owed; Your account is where it is paid.
    const signed = await signIn(app, "leo", "leo-password");
    assert.equal([signed.status, ((await signed.json()) as { two_step_setup_required?: boolean }).two_step_setup_required], [200, true]);
    const form = await app.fetch("/reader/", {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "leo", password: "leo-password" }).toString(),
    });
    assert.equal([form.status, form.headers.get("location")], [303, "/reader/account"]);
    const me = (await (await get(app, "/api/reader/me", { cookie: leo.cookie })).json()) as { username: string; two_step_setup_required?: boolean };
    assert.equal([me.username, me.two_step_setup_required], ["leo", true]);
    const account = await get(app, "/reader/account", { cookie: leo.cookie });
    assert.equal(account.status, 200);
    assert((await account.text()).includes("Set up two-step verification to continue"));
    assert.equal(((await (await get(app, "/api/reader/two-step", { cookie: leo.cookie })).json()) as { required: boolean }).required, true);

    // Set up, and everything opens again, the key included.
    const secret = await turnOn(app, leo.cookie, "leo-password");
    assert.equal((await get(app, "/reader/home", { cookie: leo.cookie })).status, 200);
    assert.equal((await get(app, "/api/reader/view/example/", bearer)).status, 200);
    assert(!(await (await get(app, "/reader/account", { cookie: leo.cookie })).text()).includes("Set up two-step verification to continue"));
    assert.equal(((await (await get(app, "/api/reader/me", { cookie: leo.cookie })).json()) as { two_step_setup_required?: boolean }).two_step_setup_required, undefined);
    assert.equal((await signIn(app, "leo", "leo-password")).status, 401);
    assert.equal((await signIn(app, "leo", "leo-password", await codeNow(secret, 1))).status, 200);
    assert.equal(await (await get(app, "/api/admin/reader-settings", { cookie: ana })).json(), { two_step_required: true, readers_without_two_step: 0 });

    // Turning it off while it is required is allowed (a new phone), and owes the setup again at once.
    assert.equal((await post(app, "/disable", leo.cookie, { current_password: "leo-password" })).status, 200);
    assert.equal((await get(app, "/reader/home", { cookie: leo.cookie })).headers.get("location"), "/reader/account");

    // No longer required: Leo reads with the password alone; Mia keeps what she turned on.
    assert.equal((await require(app, ana, false)).status, 200);
    assert.equal((await get(app, "/reader/home", { cookie: leo.cookie })).status, 200);
    assert.equal((await signIn(app, "mia", "mia-password")).status, 401);
    assert.equal((await signIn(app, "mia", "mia-password", await codeNow(miaSecret, 1))).status, 200);

    const changes = await audit(app, ana, "action=settings.updated");
    assert.equal(changes.map((row) => [row.actor.name, row.details]), [["ana", { reader_two_step_required: false }], ["ana", { reader_two_step_required: true }]]);
  });

  test("reader two-step: a new reader sets it up right after choosing the password, and a link never stands in for the code", { secrets }, async (app) => {
    const ana = await createAdmin(app);
    assert.equal((await require(app, ana, true)).status, 200);
    const page = await (await get(app, "/admin/list-readers", { cookie: ana })).text();
    assert(page.includes("two-step-optional") && page.includes("Required"));

    // The link signs the new reader in, and the first page is the setup.
    const leo = await pendingReader(app, ana);
    const chosen = await app.fetch(leo.link, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "leo-password", confirm: "leo-password" }).toString(),
    });
    assert.equal([chosen.status, chosen.headers.get("location")], [303, "/reader/account"]);
    const cookie = cookieOf(chosen);
    assert.equal((await get(app, "/reader/home", { cookie })).headers.get("location"), "/reader/account");

    // The link page said so beforehand.
    const mia = await pendingReader(app, ana, "mia");
    const linkPage = await (await get(app, mia.link, {})).text();
    assert(linkPage.includes("you will set up two-step verification") && linkPage.includes("Create password and continue"));

    // The setup has started already: the password was chosen a moment ago, and is not asked again.
    // Your account opens on the QR code to scan, with the key beside it for who cannot scan.
    const send = (fields: Record<string, string>) => app.fetch("/reader/account", {
      method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
    });
    const setupPage = await (await get(app, "/reader/account", { cookie })).text();
    assert(/id="two-step-qr"><svg [^>]*role="img"/.test(setupPage), "the setup shows a QR code");
    const secret = /id="two-step-key">([A-Z2-7]{32})</.exec(setupPage)?.[1] ?? "";
    assert(secret !== "", "the setup started with the link");
    assert.equal((await audit(app, ana, "action=mfa.setup")).map((row) => [row.actor.name, row.target?.name]), [["leo", "leo"]]);
    // Until a code confirms it, nothing else opens and the password alone still signs in (to this same page).
    assert.equal((await signIn(app, "leo", "leo-password")).status, 200);
    assert.equal((await send({ action: "two-step-confirm", code: "000000" })).headers.get("location")?.includes("error="), true);
    assert.equal((await send({ action: "two-step-confirm", code: await codeNow(secret) })).status, 303);
    assert.equal((await get(app, "/reader/home", { cookie })).status, 200);

    // A password link for a reader with two-step verification on changes the password and signs nobody in.
    const { url } = (await (await app.fetch(`/api/admin/readers/${leo.id}/invite`, { method: "POST", headers: { cookie: ana } })).json()) as { url: string };
    const reset = await app.fetch(`/api${new URL(url).pathname}`, json("POST", { password: "another-password" }));
    assert.equal([reset.status, reset.headers.getSetCookie().length, ((await reset.json()) as { signed_in: boolean }).signed_in], [200, 0, false]);
    assert.equal((await get(app, "/api/reader/me", { cookie })).status, 401);
    assert.equal((await signIn(app, "leo", "another-password")).status, 401);
    assert.equal((await signIn(app, "leo", "another-password", await codeNow(secret, 1))).status, 200);
  });
}
