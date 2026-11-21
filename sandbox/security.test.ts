import type { Tests } from "../deps/testing.ts";
import { type Config, DEFAULT_CONFIG, clientIp, parseConfig, publicOrigin, sameOrigin, withHeaders } from "./config.ts";
import { ROOT, helpers, secrets } from "./test-helpers.ts";

// Headers, the origin check, the password rules and the installation's
// settings file. The settings are tested as plain functions: what a given
// installation wrote in its sites/gatefold.json is not this suite's business.
export default function ({ test, assert }: Tests) {
  const { json, createAdmin, pendingReader, uploadSource } = helpers(assert);
  const config = (changes: Partial<Config>): Config => ({ ...DEFAULT_CONFIG, ...changes });

  test("headers: pages, data and source files each leave with their policy", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const page = await app.fetch("/admin/home", { headers: { cookie: admin } });
    const pagePolicy = page.headers.get("content-security-policy") ?? "";
    assert(pagePolicy.includes("default-src 'none'") && pagePolicy.includes("frame-ancestors 'none'") && pagePolicy.includes("script-src 'self'"));
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");

    // Data is not a page: nothing in it may run, load or be framed. Errors and refusals included.
    for (const response of [
      await app.fetch("/api/admin/me", { headers: { cookie: admin } }),
      await app.fetch("/api/admin/me"),
      await app.fetch("/api/admin/login", json("POST", { username: "ana", password: "wrong-password" })),
    ]) {
      assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("cache-control"), "no-store");
      await response.arrayBuffer();
    }
    const moved = await app.fetch("/");
    assert.equal([moved.status, moved.headers.get("x-content-type-options")], [303, "nosniff"]);

    // A source's files may only be framed by this site.
    await uploadSource(app, admin, { public: true });
    for (const path of ["/reader/view/example/", "/reader/view/example/style.css"]) {
      const file = await app.fetch(path);
      assert.equal([file.status, file.headers.get("content-security-policy"), file.headers.get("x-frame-options")], [200, "frame-ancestors 'self'", "SAMEORIGIN"], path);
      await file.arrayBuffer();
    }
  });

  test("headers: HTTPS is remembered by the browser only where the installation is reached by HTTPS", () => {
    const answer = (url: string, settings: Partial<Config> = {}): Headers =>
      withHeaders(new Request(url), Response.json({ ok: true }), config(settings)).headers;
    assert.equal(answer("https://pages.example.com/api/admin/me").get("strict-transport-security"), "max-age=15552000");
    assert.equal(answer("http://127.0.0.1:3000/api/admin/me").get("strict-transport-security"), null);
    // Behind a proxy that ends HTTPS, the app sees plain HTTP: the installation says what its address is.
    assert.equal(answer("http://127.0.0.1:3000/x", { public_url: "https://pages.example.com" }).get("strict-transport-security"), "max-age=15552000");

    // What a page already decided is kept.
    const page = new Response("<p>hi</p>", { headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'", "referrer-policy": "same-origin" } });
    const kept = withHeaders(new Request("https://pages.example.com/"), page, DEFAULT_CONFIG).headers;
    assert.equal([kept.get("content-security-policy"), kept.get("referrer-policy")], ["default-src 'self'", "same-origin"]);
    // A script or a stylesheet gets no policy of its own, and an answer with locked headers is still answered.
    assert.equal(withHeaders(new Request("https://x.test/"), new Response("x", { headers: { "content-type": "text/javascript" } }), DEFAULT_CONFIG).headers.get("content-security-policy"), null);
    assert.equal(withHeaders(new Request("https://x.test/"), Response.redirect("https://x.test/y", 303), DEFAULT_CONFIG).headers.get("x-content-type-options"), "nosniff");
  });

  test("a sign-in sent from another site is refused, on the page and on the API", { secrets }, async (app) => {
    await createAdmin(app);
    const forged = { origin: "https://fake-site.example" };
    const api = await app.fetch("/api/admin/login", json("POST", { username: "ana", password: "ana-password" }, forged));
    assert.equal([api.status, api.headers.getSetCookie().length], [403, 0]);
    const form = await app.fetch("/admin/", { method: "POST", headers: forged, body: new URLSearchParams({ username: "ana", password: "ana-password" }) });
    assert.equal(form.headers.getSetCookie().length, 0);
    assert((form.headers.get("location") ?? "").includes("error="));
    assert.equal((await app.fetch("/api/admin/login", json("POST", { username: "ana", password: "ana-password" }, { "sec-fetch-site": "cross-site" }))).status, 403);
    assert.equal((await app.fetch("/api/admin/login", json("POST", { username: "ana", password: "ana-password" }, { "sec-fetch-site": "same-origin" }))).status, 200);
  });

  test("passwords: long enough, not the account's own name or email, not one anyone would guess", { secrets }, async (app) => {
    const root = { "x-root-password": ROOT };
    const create = (username: string, password: string) => app.fetch("/api/root/admins", json("POST", { username, password }, root));
    for (const [username, password] of [
      ["ana", "ninechars"], ["anastasia.reis", "Anastasia.Reis"], ["ana", "aaaaaaaaaaaa"], ["ana", "abababababab"], ["ana", "Password123"], ["ana", "1234567890"], ["ana", "x".repeat(257)],
    ] as const) {
      const refused = await create(username, password);
      assert.equal(refused.status, 400, password);
      assert(((await refused.json()) as { error: string }).error.toLowerCase().includes("password"));
    }
    assert.equal((await create("ana", "ana-password")).status, 201);

    const admin = (await app.fetch("/api/admin/login", json("POST", { username: "ana", password: "ana-password" }))).headers.getSetCookie()[0]!.split(";")[0]!;
    // Changing an administrator's password follows the same rules.
    const { items } = (await (await app.fetch("/api/admin/admins", { headers: { cookie: admin } })).json()) as { items: { id: string }[] };
    assert.equal((await app.fetch(`/api/admin/admins/${items[0]!.id}`, json("PUT", { username: "anastasia1", password: "anastasia1" }, { cookie: admin }))).status, 400);
    // A reader's link refuses their own name and email too, whatever the case.
    const leo = await pendingReader(app, admin, "leonardo.dias");
    for (const password of ["leonardo.dias", "LEONARDO.DIAS", leo.email, "qwertyuiop"]) {
      assert.equal((await app.fetch(`/api${leo.link}`, json("POST", { password }))).status, 400, password);
    }
    assert.equal((await app.fetch(`/api${leo.link}`, json("POST", { password: "a long sentence works" }))).status, 200);
  });

  test("settings: the visitor's address comes from the one header the installation trusts", () => {
    const request = new Request("https://pages.example.com/", {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 203.0.113.9", "x-real-ip": "2001:db8::1" },
    });
    assert.equal(clientIp(request, config({ client_ip: "cloudflare" })), "203.0.113.7");
    // The last address is the one the proxy in front of the app wrote: the others came with the request.
    assert.equal(clientIp(request, config({ client_ip: "x-forwarded-for" })), "203.0.113.9");
    assert.equal(clientIp(request, config({ client_ip: "x-real-ip" })), "2001:db8::1");
    assert.equal(clientIp(request, config({ client_ip: "none" })), null);
    const bare = new Request("https://pages.example.com/", { headers: { "x-real-ip": "<script>alert(1)</script>" } });
    assert.equal([clientIp(bare, DEFAULT_CONFIG), clientIp(bare, config({ client_ip: "x-forwarded-for" })), clientIp(bare, config({ client_ip: "x-real-ip" }))], [null, null, null]);
  });

  test("settings: the public address is what links and the origin check go by", () => {
    const proxied = config({ public_url: "https://pages.example.com" });
    const from = (origin: string | null, extra: Record<string, string> = {}): Request =>
      new Request("http://127.0.0.1:3000/api/admin/config", { method: "PUT", headers: { ...(origin ? { origin } : {}), ...extra } });
    assert.equal(publicOrigin(from(null), DEFAULT_CONFIG), "http://127.0.0.1:3000");
    assert.equal(publicOrigin(from(null), proxied), "https://pages.example.com");
    assert.equal(sameOrigin(from("https://pages.example.com"), DEFAULT_CONFIG), false);
    assert.equal(sameOrigin(from("https://pages.example.com"), proxied), true);
    assert.equal(sameOrigin(from("http://127.0.0.1:3000"), proxied), true);
    assert.equal(sameOrigin(from("https://fake-site.example"), proxied), false);
    assert.equal(sameOrigin(from(null, { "sec-fetch-site": "cross-site" }), proxied), false);
    // A script, which sends neither header, is not a browser being tricked.
    assert.equal(sameOrigin(from(null), proxied), true);
  });

  test("settings: sites/gatefold.json is read key by key, with a default for whatever is wrong", () => {
    assert.equal(parseConfig({}), DEFAULT_CONFIG);
    assert.equal(parseConfig({ client_ip: "x-forwarded-for", public_url: "https://pages.example.com/some/path" }),
      { client_ip: "x-forwarded-for", public_url: "https://pages.example.com", problems: [] });
    for (const broken of [null, [], "cloudflare", 3]) assert.equal(parseConfig(broken).problems.length, 1);
    const wrong = parseConfig({ client_ip: "x-client-ip", public_url: "pages.example.com", debug: true });
    assert.equal([wrong.client_ip, wrong.public_url, wrong.problems.length], ["cloudflare", null, 3]);
    assert.equal(parseConfig({ public_url: "javascript:alert(1)" }).public_url, null);
  });
}
