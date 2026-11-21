// What the test files share: made-up secrets and the steps most tests start
// with (an administrator, a reader who has chosen a password).
//
// Tests also run in every installation after an update, against that
// installation's own sites/ folder. So nothing here, and nothing in a test,
// may count on the brand that ships with Gatefold or on any setting an
// installation is free to change. The source the tests read is uploaded by
// the tests themselves: see `uploadSource`.
import type { App, Tests } from "../deps/testing.ts";

// Made-up values: tests never see the real secrets.
export const ROOT = "test-root-password-0123456789-abcdef";
export const secrets = { GATEFOLD_ROOT_PASSWORD: ROOT, GATEFOLD_MASTER_KEY: "test-master-key", GATEFOLD_SIGNING_KEY: "test-signing-key" };

const JSON_HEADERS = { "content-type": "application/json" };

export interface ExampleSource {
  alias: string;
  public: boolean;
  props: Record<string, unknown>;
  render: string[];
  origin: string;
  files: number;
  bytes: number;
}

/** A small site with everything a source can have: a template, a folder, a stylesheet, an image and its settings. */
export const FIXTURE: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{ props.title | default: "Gatefold example" }}</title><link rel="stylesheet" href="style.css"></head>
<body><main>
<h1>{{ props.title | default: "Gatefold example" }}</h1>
{% if props.theme == "dark" %}<p>You chose the <strong>dark</strong> theme in your props.</p>{% else %}<p>Set the theme in the props to see this sentence change.</p>{% endif %}
{% for item in props.notices %}<p>{{ forloop.index }}. {{ item }}</p>{% else %}<p>No notices.</p>{% endfor %}
<p>Page asked in the query: {{ query.page | default: "none" }}</p>
<p>Browser language: {{ headers.accept-language | default: "not sent" }}</p>
<p>{% raw %}Inside a raw block, {{ this }} and {% this %} appear exactly as written.{% endraw %}</p>
<p><a href="about/">Another page of this source</a></p>
</main></body></html>
`,
  "about/index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>About</title></head>
<body><h1>About this example</h1><p><a href="../">Back</a></p></body></html>
`,
  "style.css": `/* This file does not go through the template engine: only "html" is rendered by default. {{ props.title }} */
body { margin: 0; font: 17px/1.65 system-ui, sans-serif; }
`,
  "img/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2f5bea"/></svg>
`,
  "source.json": `{ "render": ["html"], "props": { "title": "Props & templates" } }
`,
};

export interface AuditRow {
  id: number;
  at: number;
  actor: { role: string; id: string | null; name: string; via: string; ip: string | null };
  action: string;
  target: { type: string; id: string | null; name: string | null } | null;
  details: Record<string, unknown>;
}

export function helpers(assert: Tests["assert"]) {
  const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method,
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });

  /** The session cookie returned by a sign-in, ready for the `cookie` header. */
  const cookieOf = (response: Response): string => (response.headers.getSetCookie()[0] ?? "").split(";")[0]!;

  const createAdmin = async (app: App, username = "ana", password = "ana-password"): Promise<string> => {
    const created = await app.fetch("/api/root/admins", json("POST", { username, password }, { "x-root-password": ROOT }));
    assert.equal(created.status, 201);
    const login = await app.fetch("/api/admin/login", json("POST", { username, password }));
    assert.equal(login.status, 200);
    return cookieOf(login);
  };

  /** The path of an access link, as the app can be asked for it (`/reader/invite/<token>`). */
  const invitePath = (url: string): string => new URL(url).pathname;

  /** A reader who exists but has not chosen a password: `link` is the path of their access link. */
  const pendingReader = async (app: App, admin: string, username = "leo"): Promise<{ id: string; link: string; email: string }> => {
    const email = `${username.toLowerCase()}@example.test`;
    const created = await app.fetch("/api/admin/readers", json("POST", { username, email }, { cookie: admin }));
    assert.equal(created.status, 201);
    const reader = (await created.json()) as { id: string; pending: boolean; invite: { url: string; expires_at: number } };
    assert.equal(reader.pending, true);
    return { id: reader.id, link: invitePath(reader.invite.url), email };
  };

  /** Chooses the password through the link, as the reader would. Returns the session cookie. */
  const acceptInvite = async (app: App, link: string, password: string): Promise<string> => {
    const accepted = await app.fetch(`/api${link}`, json("POST", { password }));
    assert.equal(accepted.status, 200);
    return cookieOf(accepted);
  };

  /** A reader with a password, signed in. */
  const createReader = async (app: App, admin: string, username = "leo", password = "leo-password"): Promise<{ id: string; cookie: string; email: string }> => {
    const reader = await pendingReader(app, admin, username);
    return { id: reader.id, email: reader.email, cookie: await acceptInvite(app, reader.link, password) };
  };

  /**
   * Creates the source `alias` and uploads the files of `FIXTURE` to it, as a
   * script holding an administrator's credential would. It starts private;
   * `settings.public` makes it public.
   */
  const uploadSource = async (app: App, admin: string, settings: { public?: boolean; alias?: string } = {}): Promise<ExampleSource> => {
    const alias = settings.alias ?? "example";
    const created = await app.fetch("/api/admin/sources", json("POST", { alias, public: settings.public === true }, { cookie: admin }));
    assert.equal(created.status, 201);
    await created.arrayBuffer();
    for (const [path, content] of Object.entries(FIXTURE)) {
      const sent = await app.fetch(`/api/admin/sources/${alias}/files/${path}`, { method: "PUT", headers: { cookie: admin }, body: content });
      assert.equal(sent.status, 201, path);
      await sent.arrayBuffer();
    }
    const found = await app.fetch(`/api/admin/sources/${alias}`, { headers: { cookie: admin } });
    assert.equal(found.status, 200);
    const source = (await found.json()) as ExampleSource;
    assert.equal([source.public, source.files], [settings.public === true, Object.keys(FIXTURE).length]);
    return source;
  };

  /** The audit log, newest first. `query` is the filter part of the address ("action=login"). */
  const audit = async (app: App, admin: string, query = ""): Promise<AuditRow[]> => {
    const response = await app.fetch(`/api/admin/audit${query ? `?${query}` : ""}`, { headers: { cookie: admin } });
    assert.equal(response.status, 200);
    return ((await response.json()) as { items: AuditRow[] }).items;
  };

  return { json, cookieOf, createAdmin, invitePath, pendingReader, acceptInvite, createReader, uploadSource, audit };
}
