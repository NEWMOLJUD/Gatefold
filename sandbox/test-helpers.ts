// What the test files share: made-up secrets and the steps most tests start
// with (an administrator, a reader who has chosen a password).
//
// Tests also run in every installation after an update, against that
// installation's own sites/ folder. So nothing here, and nothing in a test,
// may count on the brand that ships with Gatefold, on the `example` source
// being there, or on any setting an installation is free to change.
import type { App, Tests } from "../deps/testing.ts";

// Made-up values: tests never see the real secrets.
export const ROOT = "test-root-password-0123456789-abcdef";
export const secrets = { GATEFOLD_ROOT_PASSWORD: ROOT, GATEFOLD_MASTER_KEY: "test-master-key", GATEFOLD_SIGNING_KEY: "test-signing-key" };

const JSON_HEADERS = { "content-type": "application/json" };

export interface ExampleSource {
  public: boolean;
  props: Record<string, unknown>;
  render: string[];
  origin: string;
  missing: boolean;
}

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
   * The source `example` (the folder that ships with the template), which exists
   * without anyone registering it. Returns `null` if the installation removed
   * the folder. `settings.public` makes it public.
   */
  const exampleSource = async (app: App, admin: string, settings: { public?: boolean } = {}): Promise<ExampleSource | null> => {
    const found = await app.fetch("/api/admin/sources/example", { headers: { cookie: admin } });
    if (found.status === 404) return null;
    assert.equal(found.status, 200);
    const source = (await found.json()) as ExampleSource;
    // A folder that was just detected is private until an administrator says otherwise.
    assert.equal(source.public, false);
    assert.equal(source.missing, false);
    if (!settings.public) return source;
    assert.equal((await app.fetch("/api/admin/sources/example", json("PUT", { public: true }, { cookie: admin }))).status, 200);
    return { ...source, public: true };
  };

  /**
   * The audit log, newest first. `query` is the filter part of the address
   * ("action=login"). The rows for the folders found in sites/sources/ are left
   * out: how many there are depends on the installation.
   */
  const audit = async (app: App, admin: string, query = ""): Promise<AuditRow[]> => {
    const response = await app.fetch(`/api/admin/audit${query ? `?${query}` : ""}`, { headers: { cookie: admin } });
    assert.equal(response.status, 200);
    return ((await response.json()) as { items: AuditRow[] }).items.filter((row) => row.action !== "source.detected");
  };

  return { json, cookieOf, createAdmin, invitePath, pendingReader, acceptInvite, createReader, exampleSource, audit };
}
