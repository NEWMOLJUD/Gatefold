// The pages of the administrator, the reader and root. Each form calls the
// same operation of `core.ts` that the API calls.
import type { Server } from "../deps/server.ts";
import {
  type Ctx, HttpError, PLATFORM_PROPS, Reply, SOURCE_ALIASES, type Session, type Statement, type UserRef, accountQueries, accountsPage,
  apiKeys, apiKeysQuery, createAccount, createApiKey, createSource, deleteAccount, deleteApiKey, deleteSource,
  identify, listAccountsQuery, listSourcesQuery, login, logout, oneAccount, oneSource, platformProps, readableSources,
  readableSourcesQuery, redirect, setPlatformProps, setReaderProps, sourceQuery, sourcesPage, updateAccount, updateSource,
} from "./core.ts";
import { JS_PATH, type PageOptions, type Safe, alert, asset, badge, card, date, empty, field, html, icon, page, pager } from "./html.ts";
import { labelFile, loadLabel } from "./label.ts";
import { ROOT_SCRIPT } from "./root.ts";
import { type Role, sameOrigin } from "./security.ts";
import { view } from "./view.ts";

type PageHandler = (request: Request, url: URL, params: Record<string, string>) => Promise<Response>;

/** The `next` of the sign-in page is only honoured when it is an internal source path. */
export function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith("/reader/view/") || next.includes("//") || next.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(next) ? null : next;
}

const LOGIN: Record<Role, { path: string; home: string; subtitle: string }> = {
  admin: { path: "/admin/", home: "/admin/home", subtitle: "Administration console. Use your administrator account." },
  reader: { path: "/reader/", home: "/reader/home", subtitle: "Use the account your administrator gave you." },
};

/** Numbers of the overview page, in one statement. */
const COUNTS: Statement = [
  "SELECT (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM sources WHERE public = 1) AS public_sources, " +
    "(SELECT COUNT(*) FROM readers) AS readers, (SELECT COUNT(*) FROM admins) AS admins",
];

const PROPS_WARNING = "Props personalise pages; they never control access. A reader can override any key with their own preferences.";

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function propsArea(value: unknown): Safe {
  return html`<textarea id="props" name="props" spellcheck="false" data-json>${pretty(value)}</textarea>`;
}

export function registerPages(server: Server, ctx: Ctx): void {
  const show = async (options: PageOptions): Promise<Response> => page(await loadLabel(ctx.sites), options);

  /** Errors become a page; a form that fails goes back to its own address with the message. */
  const route = (method: "GET" | "POST", path: string, handler: PageHandler): void => {
    server.route(method, path, async (request, params) => {
      const url = new URL(request.url);
      try {
        return await handler(request, url, params);
      } catch (error) {
        if (error instanceof Reply) return error.response;
        if (!(error instanceof HttpError)) throw error;
        if (request.method === "POST") {
          url.searchParams.delete("ok");
          url.searchParams.set("error", error.message);
          return redirect(url.pathname + url.search);
        }
        const admin = url.pathname.startsWith("/admin/");
        return show({
          title: error.status === 403 ? "No access" : error.status === 404 ? "Not found" : "Something went wrong",
          subtitle: error.message,
          body: html`<a class="btn" href="${admin ? "/admin/home" : "/reader/home"}">${admin ? "Back to the overview" : "Back to your library"}</a>`,
          status: error.status,
        });
      }
    });
  };

  /** Requires the session of the role; without it, goes to sign-in. The reads share the same trip to the database. */
  const enter = async (request: Request, role: Role, reads?: (user: UserRef) => Statement[]): Promise<Session> => {
    const { session } = await identify(ctx, request, role, { allowKey: false, reads });
    if (!session) throw new Reply(redirect(LOGIN[role].path));
    return session;
  };

  const done = (path: string, message: string): Response => redirect(`${path}${path.includes("?") ? "&" : "?"}ok=${encodeURIComponent(message)}`);

  route("GET", "/", async () => redirect("/reader/"));

  // The built-in script, and the white-label files of sites/label/ (stylesheets, logo).
  server.route("GET", JS_PATH, () => asset());
  server.route("GET", "/label/*", (request, params) => labelFile(ctx.sites, request, params["*"] ?? ""));

  // -------------------------------------------------------------------------
  // Sign-in, sign-out and API keys: the same for both roles
  // -------------------------------------------------------------------------

  for (const role of ["admin", "reader"] as const) {
    const { path, home, subtitle } = LOGIN[role];
    const destination = (url: URL): string => (role === "reader" ? (safeNext(url.searchParams.get("next")) ?? home) : home);

    route("GET", path, async (request, url) => {
      const { session } = await identify(ctx, request, role, { allowKey: false });
      if (session) return redirect(destination(url));
      const body = html`<form method="post">
${field("username", "Username", html`<input type="text" id="username" name="username" autocomplete="username" required autofocus>`)}
${field("password", "Password", html`<input type="password" id="password" name="password" autocomplete="current-password" required>`)}
<div class="field"><button class="btn btn-primary btn-block">Sign in</button></div></form>
<p class="auth-alt">${role === "reader"
  ? html`Managing this installation? <a href="/admin/">Administrator sign-in</a>`
  : html`Here to read? <a href="/reader/">Reader sign-in</a>`}</p>`;
      return show({ title: role === "admin" ? "Administrator sign-in" : "Sign in", subtitle, body, url });
    });

    route("POST", path, async (request, url) => {
      if (!sameOrigin(request)) throw new HttpError(403, "Request refused: it did not come from this site.");
      const form = await request.formData();
      const { cookie } = await login(ctx, role, { username: text(form, "username"), password: text(form, "password") });
      return redirect(destination(url), [cookie]);
    });

    route("POST", `/${role}/logout`, async (request) => redirect(path, [await logout(ctx, request, role)]));

    route("GET", `/${role}/api-keys`, async (request, url) => {
      const session = await enter(request, role, (user) => [apiKeysQuery(role, user)]);
      return keysPage(session, url, null);
    });

    route("POST", `/${role}/api-keys`, async (request, url) => {
      const session = await enter(request, role);
      const form = await request.formData();
      if (text(form, "action") === "revoke") {
        await deleteApiKey(ctx, role, session.user.id, text(form, "key"));
        return done(`/${role}/api-keys`, "Key revoked.");
      }
      // No redirect: the key appears in this response and nowhere else.
      const created = await createApiKey(ctx, role, session.user.id);
      return keysPage(session, url, created.key);
    });
  }

  const keysPage = (session: Session, url: URL, created: string | null): Promise<Response> => {
    const role = session.role;
    const keys = apiKeys(session.rows[0]);
    const body = created
      ? card(html`<p>This is the only time the key is shown. Store it somewhere safe, such as a password manager.</p>
<div class="secret"><code id="new-key">${created}</code><button type="button" class="btn btn-sm" data-copy="#new-key">Copy</button></div>
<p class="muted">Send it in the header <code>Authorization: Bearer &lt;key&gt;</code>.</p>`,
        { title: "Copy your new key now", footer: html`<a class="btn btn-primary" href="/${role}/api-keys">I have copied it</a>` })
      : card(keys.length === 0
        ? empty("key", "No API keys yet", html`A key works as your sign-in on the <code>/api/${role}/…</code> routes, for scripts and integrations.`)
        : html`<div class="table-wrap"><table><thead><tr><th>Key ID</th><th>Created (UTC)</th><th></th></tr></thead><tbody>
${keys.map((key) => html`<tr><td><code>${key.id}</code></td><td>${date(key.created_at)}</td>
<td class="end"><form method="post" data-confirm="Revoke this key? Anything that uses it stops working at once.">
<input type="hidden" name="action" value="revoke"><input type="hidden" name="key" value="${key.id}"><button class="btn btn-danger btn-sm">Revoke</button></form></td></tr>`)}
</tbody></table></div>`, { flush: true });
    return show({
      title: "API keys",
      subtitle: html`Keys for the <code>/api/${role}/…</code> routes, sent as <code>Authorization: Bearer &lt;key&gt;</code>. The key ID is not the key.`,
      actions: created ? undefined : html`<form method="post"><input type="hidden" name="action" value="create"><button class="btn btn-primary">${icon("plus")}Generate key</button></form>`,
      body, role, username: session.user.username, active: `/${role}/api-keys`, url,
    });
  };

  // -------------------------------------------------------------------------
  // Administrator
  // -------------------------------------------------------------------------

  const adminPage = (session: Session, url: URL, options: Omit<PageOptions, "role" | "username" | "url">): Promise<Response> =>
    show({ ...options, role: "admin", username: session.user.username, url });

  route("GET", "/admin/home", async (request, url) => {
    const session = await enter(request, "admin", () => [COUNTS]);
    const counts = session.rows[0]?.[0] ?? {};
    const sources = Number(counts.sources ?? 0);
    const stat = (href: string, label: string, symbol: "folder" | "users" | "shield", value: number, note: string): Safe =>
      html`<a class="stat" href="${href}"><span class="stat-top">${label}${icon(symbol)}</span><b>${value}</b><small>${note}</small></a>`;
    const body = html`
${sources === 0 ? alert("info", html`<p><strong>No source is registered yet.</strong> Nobody can read a folder of <code>sites/sources/</code> until it is registered. <a href="/admin/create-source">Register a source</a></p>`) : ""}
<div class="stats">
${stat("/admin/list-sources", "Sources", "folder", sources, `${Number(counts.public_sources ?? 0)} public · ${sources - Number(counts.public_sources ?? 0)} private`)}
${stat("/admin/list-readers", "Readers", "users", Number(counts.readers ?? 0), "Accounts that can sign in to read")}
${stat("/admin/list-admins", "Administrators", "shield", Number(counts.admins ?? 0), "Accounts that manage this installation")}
</div>
${card(html`<div class="links">
<a href="/admin/create-source">${icon("folder")}<div><strong>Register a source</strong><span>Publish a folder of <code>sites/sources/</code> and choose who reads it.</span></div></a>
<a href="/admin/create-reader">${icon("users")}<div><strong>Add a reader</strong><span>Create an account and grant it private sources.</span></div></a>
<a href="/admin/config">${icon("sliders")}<div><strong>Edit platform props</strong><span>Values available to every template of every source.</span></div></a>
<a href="/admin/api-keys">${icon("key")}<div><strong>Create an API key</strong><span>Automate everything this console does.</span></div></a>
</div>`, { title: "Quick actions", flush: true })}`;
    return adminPage(session, url, { title: "Overview", subtitle: `Signed in as ${session.user.username}.`, body, active: "/admin/home" });
  });

  route("GET", "/admin/config", async (request, url) => {
    const session = await enter(request, "admin", () => [PLATFORM_PROPS]);
    const body = html`<form method="post">${card(
      html`${field("props", "Props (JSON object)", propsArea(platformProps(session.rows[0])),
        html`Templates read them as <code>{{ props.key }}</code>. Source props and reader props win over these when they share a key.`)}`,
      { class: "narrow", footer: html`<button class="btn btn-primary">Save props</button>` })}</form>
<div class="narrow">${alert("warn", PROPS_WARNING)}</div>`;
    return adminPage(session, url, { title: "Platform props", subtitle: "Values shared by every source of this installation.", body, active: "/admin/config" });
  });

  route("POST", "/admin/config", async (request) => {
    await enter(request, "admin");
    await setPlatformProps(ctx, text(await request.formData(), "props"));
    return done("/admin/config", "Platform props saved.");
  });

  // Sources -----------------------------------------------------------------

  const SOURCES: [string, string] = ["Sources", "/admin/list-sources"];

  route("GET", "/admin/list-sources", async (request, url) => {
    const session = await enter(request, "admin", () => [listSourcesQuery(url.searchParams)]);
    const list = await sourcesPage(ctx, session.rows[0] ?? [], url.searchParams);
    const value = (name: string): string => url.searchParams.get(name) ?? "";
    const filtered = ["q", "created_from", "created_to", "min_readers"].some((name) => value(name) !== "");
    const body = card(html`<form method="get" class="filters">
${field("q", "Alias starts with", html`<input type="text" id="q" name="q" value="${value("q")}">`)}
${field("from", "Created from", html`<input type="date" id="from" name="created_from" value="${value("created_from")}">`)}
${field("to", "Created until", html`<input type="date" id="to" name="created_to" value="${value("created_to")}">`)}
${field("min", "Minimum readers", html`<input type="number" id="min" name="min_readers" min="0" value="${value("min_readers")}">`)}
<button class="btn">Apply filters</button></form>
${list.items.length === 0
  ? filtered
    ? empty("folder", "No sources match these filters", "Change or clear the filters to see more.", html`<a class="btn" href="/admin/list-sources">Clear filters</a>`)
    : empty("folder", "No sources yet", html`A source is a folder of <code>sites/sources/</code> that you publish to readers.`,
        html`<a class="btn btn-primary" href="/admin/create-source">Register the first source</a>`)
  : html`<div class="table-wrap"><table><thead><tr><th>Source</th><th>Visibility</th><th class="num">Readers</th><th>Rendered</th><th>Created (UTC)</th><th></th></tr></thead><tbody>
${list.items.map((source) => html`<tr><td><strong><a href="/admin/edit-source?source=${source.alias}">${source.alias}</a></strong>
${source.missing ? html` ${badge("Folder missing", "danger")}` : ""}</td>
<td>${source.public ? badge("Public", "warn") : badge("Private", "ok")}</td>
<td class="num"><a href="/admin/list-readers?source=${source.alias}">${source.readers}</a></td>
<td>${source.render.length === 0 ? html`<span class="muted">Nothing</span>` : source.render.map((extension) => html`<span class="chip">${extension}</span>`)}</td>
<td>${date(source.created_at)}</td>
<td class="end"><a class="btn btn-sm" href="/reader/view/${source.alias}/">Open ${icon("external")}</a></td></tr>`)}</tbody></table></div>`}
${pager(url, list.page, list.hasNext)}`, { flush: true });
    return adminPage(session, url, {
      title: "Sources", subtitle: "Folders of sites/sources/ published to readers.", body, active: "/admin/list-sources",
      actions: html`<a class="btn btn-primary" href="/admin/create-source">${icon("plus")}Register source</a>`,
    });
  });

  const sourceFields = (source: { public: boolean; props: unknown; render: string[] }): Safe => html`
${card(html`<label class="check"><input type="checkbox" name="public" ${source.public ? "checked" : ""}>
<span><strong>Public source</strong><span class="hint">Anyone on the internet can open <strong>every file of the folder</strong>, without signing in.
Leave it off to allow only the readers you choose.</span></span></label>`, { title: "Visibility", class: "narrow" })}
${card(html`${field("render", "Rendered extensions", html`<input type="text" id="render" name="render" value="${source.render.join(", ")}" placeholder="html">`,
  "Separated by commas. Files with these extensions go through the template engine. Leave empty to turn rendering off.")}
<div class="field">${alert("warn", html`Careful with <code>js</code> and <code>css</code>: files that already contain <code>{{</code> or <code>{%</code>
(Vue or Handlebars code, for instance) would be interpreted and may break. Protect those parts with
<code>{% raw %}…{% endraw %}</code>. Images, PDFs, fonts and videos are never rendered.`)}</div>`, { title: "Rendering", class: "narrow" })}
${card(field("props", "Props (JSON object)", propsArea(source.props),
  "Win over the platform props; the reader's own props win over these."), { title: "Source props", class: "narrow" })}`;

  route("GET", "/admin/create-source", async (request, url) => {
    const session = await enter(request, "admin");
    const body = html`<form method="post">${card(field("alias", "Folder of sites/sources/",
      html`<input type="text" id="alias" name="alias" required pattern="[a-z0-9-]+" maxlength="100" autocomplete="off" spellcheck="false" placeholder="example">`,
      html`Type the name of a subfolder of <code>sites/sources/</code> that has an <code>index.html</code>. It becomes the address: <code>/reader/view/&lt;folder&gt;/</code>.`), { title: "Folder", class: "narrow" })}
${sourceFields({ public: false, props: {}, render: ["html"] })}
<div class="narrow actions"><button class="btn btn-primary">Register source</button><a class="btn" href="/admin/list-sources">Cancel</a></div></form>`;
    return adminPage(session, url, { title: "Register source", crumbs: [SOURCES], body, active: "/admin/list-sources" });
  });

  route("POST", "/admin/create-source", async (request) => {
    await enter(request, "admin");
    const form = await request.formData();
    const alias = text(form, "alias");
    await createSource(ctx, { alias, public: form.has("public"), props: text(form, "props"), render: text(form, "render") });
    return done(`/admin/edit-source?source=${encodeURIComponent(alias)}`, "Source registered.");
  });

  route("GET", "/admin/edit-source", async (request, url) => {
    const alias = url.searchParams.get("source") ?? "";
    const session = await enter(request, "admin", () => [sourceQuery(alias)]);
    const source = await oneSource(ctx, session.rows[0] ?? []);
    const body = html`
${source.missing ? alert("danger", html`The folder <code>sites/sources/${source.alias}/</code> (with its <code>index.html</code>) is not in this publication, so the source answers "not found".
Put the folder back in the repository or remove this source.`) : ""}
<form method="post"><input type="hidden" name="action" value="save">${sourceFields(source)}
<div class="narrow actions"><button class="btn btn-primary">Save changes</button></div></form>
<br>
${card(html`<div class="split"><div><strong>Remove this source</strong><p class="muted">Deletes its settings and permissions. The files stay in the repository folder.</p></div>
<form method="post" data-confirm="Remove the source ${source.alias}? Readers lose access at once.">
<input type="hidden" name="action" value="delete"><button class="btn btn-danger">Remove source</button></form></div>`, { class: "narrow danger-zone" })}`;
    return adminPage(session, url, {
      title: source.alias,
      subtitle: html`${source.public ? badge("Public", "warn") : badge("Private", "ok")} &nbsp;<a href="/admin/list-readers?source=${source.alias}">${plural(source.readers, "reader", "readers")} with permission</a>`,
      crumbs: [SOURCES], body, active: "/admin/list-sources",
      actions: html`<a class="btn" href="/reader/view/${source.alias}/">Open source ${icon("external")}</a>`,
    });
  });

  route("POST", "/admin/edit-source", async (request, url) => {
    await enter(request, "admin");
    const alias = url.searchParams.get("source") ?? "";
    const form = await request.formData();
    if (text(form, "action") === "delete") {
      await deleteSource(ctx, alias);
      return done("/admin/list-sources", "Source removed.");
    }
    await updateSource(ctx, alias, { public: form.has("public"), props: text(form, "props"), render: text(form, "render") });
    return done(`/admin/edit-source?source=${encodeURIComponent(alias)}`, "Source saved.");
  });

  // Readers and administrators: the same screens, plus the sources on the reader.

  for (const role of ["reader", "admin"] as const) {
    const many = role === "reader" ? "readers" : "admins";
    const noun = role === "reader" ? "reader" : "administrator";
    const title = role === "reader" ? "Readers" : "Administrators";
    const listPath = `/admin/list-${many}`;
    const crumb: [string, string] = [title, listPath];
    const idParam = `${role}-id`;
    const editPath = (id: string): string => `/admin/edit-${role}?${idParam}=${encodeURIComponent(id)}`;

    route("GET", listPath, async (request, url) => {
      const session = await enter(request, "admin", () => [listAccountsQuery(role, url.searchParams), ...(role === "reader" ? [SOURCE_ALIASES] : [])]);
      const list = accountsPage(session.rows[0] ?? [], url.searchParams);
      const value = (name: string): string => url.searchParams.get(name) ?? "";
      const filtered = ["q", "source", "created_from", "created_to"].some((name) => value(name) !== "");
      const filters = role === "reader"
        ? html`${field("source", "Has access to", html`<select id="source" name="source"><option value="">Any source</option>
${(session.rows[1] ?? []).map((row) => html`<option ${row.alias === value("source") ? "selected" : ""}>${String(row.alias)}</option>`)}</select>`)}
${field("from", "Created from", html`<input type="date" id="from" name="created_from" value="${value("created_from")}">`)}
${field("to", "Created until", html`<input type="date" id="to" name="created_to" value="${value("created_to")}">`)}`
        : "";
      const body = card(html`<form method="get" class="filters">
${field("q", "Username starts with", html`<input type="text" id="q" name="q" value="${value("q")}">`)}${filters}
<button class="btn">Apply filters</button></form>
${list.items.length === 0
  ? filtered
    ? empty("users", `No ${many === "admins" ? "administrators" : "readers"} match these filters`, "Change or clear the filters to see more.", html`<a class="btn" href="${listPath}">Clear filters</a>`)
    : empty("users", "No readers yet", "Readers sign in to open the private sources you grant them.", html`<a class="btn btn-primary" href="/admin/create-reader">Add the first reader</a>`)
  : html`<div class="table-wrap"><table><thead><tr><th>Username</th>${role === "reader" ? html`<th class="num">Private sources</th>` : ""}<th>Created (UTC)</th><th></th></tr></thead><tbody>
${list.items.map((account) => html`<tr><td><strong><a href="${editPath(account.id)}">${account.username}</a></strong>
${role === "admin" && account.id === session.user.id ? html` ${badge("You")}` : ""}</td>
${role === "reader" ? html`<td class="num">${account.sources}</td>` : ""}<td>${date(account.created_at)}</td>
<td class="end"><a class="btn btn-sm" href="${editPath(account.id)}">Manage</a></td></tr>`)}</tbody></table></div>`}
${pager(url, list.page, list.hasNext)}`, { flush: true });
      return adminPage(session, url, {
        title, body, active: listPath,
        subtitle: role === "reader" ? "Accounts that sign in to read sources." : "Accounts that manage sources, readers and other administrators.",
        actions: html`<a class="btn btn-primary" href="/admin/create-${role}">${icon("plus")}Add ${noun}</a>`,
      });
    });

    route("GET", `/admin/create-${role}`, async (request, url) => {
      const session = await enter(request, "admin");
      const body = html`<form method="post">${card(html`
${field("username", "Username", html`<input type="text" id="username" name="username" autocomplete="off" required>`, "3 to 64 characters: letters, digits, dot, hyphen, underscore or @.")}
${field("password", "Password", html`<input type="password" id="password" name="password" autocomplete="new-password" minlength="8" required>`,
  "At least 8 characters. Share it with the person through a safe channel.")}
${role === "admin" ? html`<div class="field">${alert("warn", "An administrator can do everything, including removing the other administrators.")}</div>` : ""}`,
        { class: "narrow", footer: html`<a class="btn" href="${listPath}">Cancel</a><button class="btn btn-primary">Add ${noun}</button>` })}</form>`;
      return adminPage(session, url, {
        title: `Add ${noun}`, crumbs: [crumb], body, active: listPath,
        subtitle: role === "reader" ? "You choose the sources this reader can open on the next screen." : undefined,
      });
    });

    route("POST", `/admin/create-${role}`, async (request) => {
      await enter(request, "admin");
      const form = await request.formData();
      const account = await createAccount(ctx, role, { username: text(form, "username"), password: text(form, "password") });
      return done(editPath(account.id), role === "reader" ? "Reader added. Choose the sources they can open." : "Administrator added.");
    });

    route("GET", `/admin/edit-${role}`, async (request, url) => {
      const id = url.searchParams.get(idParam) ?? "";
      const session = await enter(request, "admin", () => accountQueries(role, id));
      const account = oneAccount(session.rows);
      const allowed = new Set(account.allowed ?? []);
      const all = session.rows[3] ?? [];
      const sources = role === "reader"
        ? card(all.length === 0
            ? html`<p class="muted">No sources registered yet. <a href="/admin/create-source">Register a source</a></p>`
            : html`${all.map((row) => row.public === 1
                ? html`<label class="check"><input type="checkbox" checked disabled><span>${String(row.alias)} ${badge("Public", "warn")}<span class="hint">Everyone can read it.</span></span></label>`
                : html`<label class="check"><input type="checkbox" name="sources" value="${String(row.alias)}" ${allowed.has(String(row.alias)) ? "checked" : ""}><span>${String(row.alias)}</span></label>`)}`,
          { title: "Sources this reader can open", description: "Changes apply as soon as you save.", class: "narrow" })
        : "";
      const keys = role === "reader" && account.api_keys.length > 0
        ? card(html`<div class="table-wrap"><table><thead><tr><th>Key ID</th><th>Created (UTC)</th><th></th></tr></thead><tbody>
${account.api_keys.map((key) => html`<tr><td><code>${key.id}</code></td><td>${date(key.created_at)}</td>
<td class="end"><form method="post" data-confirm="Revoke this key of ${account.username}?"><input type="hidden" name="action" value="revoke-key">
<input type="hidden" name="key" value="${key.id}"><button class="btn btn-danger btn-sm">Revoke</button></form></td></tr>`)}</tbody></table></div>`,
          { title: "API keys of this reader", class: "narrow", flush: true })
        : "";
      const self = role === "admin" && account.id === session.user.id;
      const body = html`<form method="post"><input type="hidden" name="action" value="save">
${card(html`${field("username", "Username", html`<input type="text" id="username" name="username" value="${account.username}" autocomplete="off" required>`)}
${field("password", "New password", html`<input type="password" id="password" name="password" autocomplete="new-password" minlength="8">`,
  "Leave blank to keep the current one. Changing it signs this user out everywhere.")}`, { title: "Account", class: "narrow" })}
${sources}<div class="narrow actions"><button class="btn btn-primary">Save changes</button></div></form>
<br>${keys}
${card(html`<div class="split"><div><strong>Remove this ${noun}</strong>
<p class="muted">Deletes the account, its sessions and its API keys${role === "reader" ? ", and its permissions" : ""}.${self ? " This is your own account: you will be signed out." : ""}</p></div>
<form method="post" data-confirm="Remove ${account.username}? This cannot be undone.">
<input type="hidden" name="action" value="delete"><button class="btn btn-danger">Remove ${noun}</button></form></div>`, { class: "narrow danger-zone" })}`;
      return adminPage(session, url, {
        title: account.username, subtitle: `${role === "reader" ? "Reader" : "Administrator"} since ${date(account.created_at)} UTC`,
        crumbs: [crumb], body, active: listPath,
      });
    });

    route("POST", `/admin/edit-${role}`, async (request, url) => {
      const session = await enter(request, "admin");
      const id = url.searchParams.get(idParam) ?? "";
      const form = await request.formData();
      const action = text(form, "action");
      if (action === "delete") {
        await deleteAccount(ctx, role, id);
        // Whoever removes their own account loses the session with it: back to sign-in.
        return role === "admin" && id === session.user.id ? redirect("/admin/") : done(listPath, "Account removed.");
      }
      if (action === "revoke-key" && role === "reader") {
        await deleteApiKey(ctx, "reader", id, text(form, "key"));
        return done(editPath(id), "Key revoked.");
      }
      await updateAccount(ctx, role, id, {
        username: text(form, "username"),
        password: text(form, "password"),
        ...(role === "reader" ? { sources: form.getAll("sources").filter((item) => typeof item === "string") } : {}),
      });
      return done(editPath(id), "Changes saved.");
    });
  }

  // -------------------------------------------------------------------------
  // Reader
  // -------------------------------------------------------------------------

  route("GET", "/reader/home", async (request, url) => {
    const session = await enter(request, "reader", (user) => [readableSourcesQuery(user)]);
    const sources = readableSources(session.rows[0]);
    const body = sources.length === 0
      ? card(empty("book", "Nothing to read yet", "No source has been shared with you so far. Ask your administrator for access."))
      : html`<ul class="tiles">${sources.map((source) => html`<li><a class="tile" href="/reader/view/${source.alias}/">
<div class="tile-top"><span class="tile-mark" aria-hidden="true">${source.alias.slice(0, 1)}</span>${source.public ? badge("Public") : badge("Shared with you", "ok")}</div>
<div><h2>${source.alias}</h2><p>/reader/view/${source.alias}/</p></div>
<span class="tile-go">Open ${icon("arrow")}</span></a></li>`)}</ul>`;
    return show({
      title: `Welcome, ${session.user.username}`, subtitle: sources.length === 0 ? undefined : `${plural(sources.length, "source", "sources")} available to you.`,
      body, role: "reader", username: session.user.username, active: "/reader/home", url,
    });
  });

  route("GET", "/reader/config", async (request, url) => {
    const session = await enter(request, "reader");
    const body = html`<form method="post">${card(
      field("props", "Your props (JSON object)", propsArea(session.user.props),
        html`For example <code>{"theme": "dark"}</code>. Which keys do something depends on each source.`),
      { class: "narrow", footer: html`<button class="btn btn-primary">Save preferences</button>` })}</form>`;
    return show({
      title: "Preferences", subtitle: "Your props personalise the pages you read. They win over the platform and source props when they share a key.",
      body, role: "reader", username: session.user.username, active: "/reader/config", url,
    });
  });

  route("POST", "/reader/config", async (request) => {
    const session = await enter(request, "reader");
    await setReaderProps(ctx, session.user.id, text(await request.formData(), "props"));
    return done("/reader/config", "Preferences saved.");
  });

  route("GET", "/reader/view/:alias", (request, _url, params) => view(ctx, request, params.alias ?? "", "", "page"));
  route("GET", "/reader/view/:alias/*", (request, _url, params) => view(ctx, request, params.alias ?? "", params["*"] ?? "", "page"));

  // -------------------------------------------------------------------------
  // Root
  // -------------------------------------------------------------------------

  route("GET", "/root/setup", async (_request, url) => {
    const body = html`<dialog id="ask"><form method="dialog">
${field("root-password", "Root password", html`<input type="password" id="root-password" autocomplete="off" required>`,
  html`The value of the <code>GATEFOLD_ROOT_PASSWORD</code> secret.`)}
<div class="field"><button class="btn btn-primary btn-block">Continue</button></div></form></dialog>
<div id="message" class="alert" hidden></div>
<div id="panel" hidden>
${card(html`<form id="create">
${field("username", "Username", html`<input type="text" id="username" autocomplete="off" required>`)}
${field("password", "Password", html`<input type="password" id="password" autocomplete="new-password" minlength="8" required>`, "At least 8 characters.")}
<div class="field"><button class="btn btn-primary">Create administrator</button></div></form>`, { title: "Create administrator" })}
${card(html`<div class="table-wrap"><table id="admins"></table></div>`, { title: "Administrators", flush: true })}
<p class="auth-alt"><a href="/admin/">Go to the administrator sign-in</a></p></div>
<noscript>${alert("danger", "This page needs JavaScript.")}</noscript>`;
    return show({
      title: "Root setup", subtitle: "Create the first administrator, or recover access, with the root password.",
      body, url, wide: true, scripts: ["/root/setup.js"],
    });
  });

  server.route("GET", "/root/setup.js", () =>
    new Response(ROOT_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } }));
}
