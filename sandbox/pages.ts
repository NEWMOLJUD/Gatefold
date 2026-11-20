// As páginas do administrador, do leitor e do root (seed.md, seção 8). Cada
// formulário chama a mesma operação de `core.ts` que a API chama.
import type { Server } from "../deps/server.ts";
import {
  type Ctx, HttpError, PLATFORM_PROPS, Reply, SOURCE_ALIASES, type Session, type Statement, type UserRef, accountQueries, accountsPage,
  apiKeys, apiKeysQuery, availableFolders, createAccount, createApiKey, createSource, deleteAccount, deleteApiKey, deleteSource,
  identify, listAccountsQuery, listSourcesQuery, login, logout, oneAccount, oneSource, platformProps, readableSources,
  readableSourcesQuery, redirect, setPlatformProps, setReaderProps, sourceQuery, sourcesPage, updateAccount, updateSource,
} from "./core.ts";
import { type Safe, date, html, page, pager } from "./html.ts";
import { ROOT_SCRIPT } from "./root.ts";
import { type Role, sameOrigin } from "./security.ts";
import { view } from "./view.ts";

type PageHandler = (request: Request, url: URL, params: Record<string, string>) => Promise<Response>;

/** O `next` do login só vale se for um caminho interno de fonte (seção 9). */
export function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith("/reader/view/") || next.includes("//") || next.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(next) ? null : next;
}

const LOGIN: Record<Role, { path: string; home: string; title: string }> = {
  admin: { path: "/admin/", home: "/admin/home", title: "Entrar como administrador" },
  reader: { path: "/reader/", home: "/reader/home", title: "Entrar" },
};

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export function registerPages(server: Server, ctx: Ctx): void {
  /** Erros viram página; um formulário que falha volta ao próprio endereço com a mensagem. */
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
          url.searchParams.set("erro", error.message);
          return redirect(url.pathname + url.search);
        }
        const body = html`<p class="note bad">${error.message}</p><p><a href="/reader/home">Voltar ao início</a></p>`;
        return page({ title: error.status === 403 ? "Sem acesso" : error.status === 404 ? "Não encontrado" : "Erro", body, status: error.status });
      }
    });
  };

  /** Exige a sessão do papel; sem ela, leva ao login. As leituras vão na mesma ida ao banco. */
  const enter = async (request: Request, role: Role, reads?: (user: UserRef) => Statement[]): Promise<Session> => {
    const { session } = await identify(ctx, request, role, { allowKey: false, reads });
    if (!session) throw new Reply(redirect(LOGIN[role].path));
    return session;
  };

  const done = (path: string, message: string): Response => redirect(`${path}${path.includes("?") ? "&" : "?"}ok=${encodeURIComponent(message)}`);

  route("GET", "/", async () => redirect("/reader/"));

  // -------------------------------------------------------------------------
  // Login e logout, iguais para os dois papéis
  // -------------------------------------------------------------------------

  for (const role of ["admin", "reader"] as const) {
    const { path, home, title } = LOGIN[role];
    const destination = (url: URL): string => (role === "reader" ? (safeNext(url.searchParams.get("next")) ?? home) : home);

    route("GET", path, async (request, url) => {
      const { session } = await identify(ctx, request, role, { allowKey: false });
      if (session) return redirect(destination(url));
      const body = html`<form method="post" class="narrow">
<label for="username">Usuário</label><input type="text" id="username" name="username" autocomplete="username" required autofocus>
<label for="password">Senha</label><input type="password" id="password" name="password" autocomplete="current-password" required>
<div class="row"><button>Entrar</button></div></form>`;
      return page({ title, body, url });
    });

    route("POST", path, async (request, url) => {
      if (!sameOrigin(request)) throw new HttpError(403, "Requisição recusada: ela não partiu deste site.");
      const form = await request.formData();
      const { cookie } = await login(ctx, role, { username: text(form, "username"), password: text(form, "password") });
      return redirect(destination(url), [cookie]);
    });

    route("POST", `/${role}/logout`, async (request) => redirect(path, [await logout(ctx, request, role)]));

    // Chaves de API: a mesma tela para os dois papéis.
    route("GET", `/${role}/api-keys`, async (request, url) => {
      const session = await enter(request, role, (user) => [apiKeysQuery(role, user)]);
      return keysPage(session, url, null);
    });

    route("POST", `/${role}/api-keys`, async (request, url) => {
      const session = await enter(request, role);
      const form = await request.formData();
      if (text(form, "action") === "revoke") {
        await deleteApiKey(ctx, role, session.user.id, text(form, "key"));
        return done(`/${role}/api-keys`, "Chave revogada.");
      }
      // Sem redirecionar: a chave aparece nesta resposta e em nenhum outro lugar.
      const created = await createApiKey(ctx, role, session.user.id);
      return keysPage(session, url, created.key);
    });
  }

  const keysPage = (session: Session, url: URL, created: string | null): Response => {
    const keys = apiKeys(session.rows[0]);
    const body = html`
${created
  ? html`<div class="note warn"><p><strong>Copie a chave agora.</strong> Ela não será mostrada de novo.</p><p><code>${created}</code></p>
<p><a href="/${session.role}/api-keys">Já copiei</a></p></div>`
  : html`<p>Uma chave de API vale como o seu login nas rotas <code>/api/${session.role}/…</code>.
Envie-a no cabeçalho <code>Authorization: Bearer &lt;chave&gt;</code>.</p>
<form method="post"><input type="hidden" name="action" value="create"><button>Gerar nova chave</button></form>
<div class="scroll"><table><tr><th>Identificador</th><th>Criada em (UTC)</th><th></th></tr>
${keys.map((key) => html`<tr><td><code>${key.id}</code></td><td>${date(key.created_at)}</td>
<td><form method="post"><input type="hidden" name="action" value="revoke"><input type="hidden" name="key" value="${key.id}"><button class="danger">Revogar</button></form></td></tr>`)}
</table></div>${keys.length === 0 ? html`<p class="soft">Nenhuma chave gerada.</p>` : ""}`}`;
    return page({ title: "Chaves de API", body, role: session.role, username: session.user.username, url });
  };

  // -------------------------------------------------------------------------
  // Administrador
  // -------------------------------------------------------------------------

  const adminPage = (session: Session, url: URL, title: string, body: Safe): Response =>
    page({ title, body, role: "admin", username: session.user.username, url });

  route("GET", "/admin/home", async (request, url) => {
    const session = await enter(request, "admin");
    const body = html`<ul class="cards">
<li><a href="/admin/list-sources"><strong>Fontes</strong><br><span class="soft">Pastas de sites/ e quem pode lê-las</span></a></li>
<li><a href="/admin/list-readers"><strong>Leitores</strong><br><span class="soft">Contas de leitura e permissões</span></a></li>
<li><a href="/admin/list-admins"><strong>Administradores</strong><br><span class="soft">Quem gerencia o sistema</span></a></li>
<li><a href="/admin/config"><strong>Props da plataforma</strong><br><span class="soft">Valores disponíveis em todos os templates</span></a></li>
<li><a href="/admin/api-keys"><strong>Chaves de API</strong><br><span class="soft">Acesso às rotas /api/admin</span></a></li></ul>`;
    return adminPage(session, url, "Painel", body);
  });

  route("GET", "/admin/config", async (request, url) => {
    const session = await enter(request, "admin", () => [PLATFORM_PROPS]);
    const body = html`<p>Props da plataforma: valem para todas as fontes. Os props da fonte e os do leitor vencem estes quando têm a mesma chave.</p>
<p class="note warn">Props servem para personalizar a interface, nunca para controlar acesso: o leitor pode sobrescrever qualquer chave.</p>
<form method="post"><label for="props">JSON</label><textarea id="props" name="props" spellcheck="false">${pretty(platformProps(session.rows[0]))}</textarea>
<div class="row"><button>Salvar</button></div></form>`;
    return adminPage(session, url, "Props da plataforma", body);
  });

  route("POST", "/admin/config", async (request) => {
    await enter(request, "admin");
    await setPlatformProps(ctx, text(await request.formData(), "props"));
    return done("/admin/config", "Props salvos.");
  });

  // Fontes ------------------------------------------------------------------

  route("GET", "/admin/list-sources", async (request, url) => {
    const session = await enter(request, "admin", () => [listSourcesQuery(url.searchParams)]);
    const list = sourcesPage(ctx, session.rows[0] ?? [], url.searchParams);
    const value = (name: string): string => url.searchParams.get(name) ?? "";
    const body = html`<p><a href="/admin/create-source">Cadastrar fonte</a></p>
<form method="get" class="row">
<div><label for="q">Alias começa com</label><input type="text" id="q" name="q" value="${value("q")}"></div>
<div><label for="from">Criada desde</label><input type="date" id="from" name="created_from" value="${value("created_from")}"></div>
<div><label for="to">Criada até</label><input type="date" id="to" name="created_to" value="${value("created_to")}"></div>
<div><label for="min">Mínimo de leitores</label><input type="number" id="min" name="min_readers" min="0" value="${value("min_readers")}"></div>
<button class="plain">Filtrar</button></form>
<div class="scroll"><table><tr><th>Alias</th><th>Visibilidade</th><th>Leitores</th><th>Renderiza</th><th>Criada em (UTC)</th><th></th></tr>
${list.items.map((source) => html`<tr><td><a href="/admin/edit-source?source=${source.alias}">${source.alias}</a>${source.missing ? html` <span class="soft">(pasta ausente)</span>` : ""}</td>
<td>${source.public ? "Pública" : "Privada"}</td><td><a href="/admin/list-readers?source=${source.alias}">${source.readers}</a></td>
<td>${source.render.join(", ") || "nada"}</td><td>${date(source.created_at)}</td>
<td><a href="/reader/view/${source.alias}/">abrir</a></td></tr>`)}</table></div>
${list.items.length === 0 ? html`<p class="soft">Nenhuma fonte encontrada.</p>` : ""}${pager(url, list.page, list.hasNext)}`;
    return adminPage(session, url, "Fontes", body);
  });

  const sourceFields = (source: { public: boolean; props: unknown; render: string[] }): Safe => html`
<label class="check"><input type="checkbox" name="public" ${source.public ? "checked" : ""}> Fonte pública</label>
<p class="note warn">Marcar como pública abre <strong>todos os arquivos da pasta</strong> para qualquer pessoa na internet, sem login.</p>
<label for="render">Extensões renderizadas <small>separadas por vírgula; vazio desliga a renderização</small></label>
<input type="text" id="render" name="render" value="${source.render.join(", ")}">
<p class="note warn">Cuidado ao incluir <code>js</code> ou <code>css</code>: arquivos que já contêm <code>{{</code> ou <code>{%</code>
(código de Vue ou Handlebars, por exemplo) seriam interpretados e podem quebrar. Proteja esses trechos com
<code>{% raw %}…{% endraw %}</code>. Imagens, PDFs, fontes e vídeos nunca são renderizados.</p>
<label for="props">Props da fonte <small>JSON</small></label><textarea id="props" name="props" spellcheck="false">${pretty(source.props)}</textarea>`;

  route("GET", "/admin/create-source", async (request, url) => {
    const session = await enter(request, "admin", () => [SOURCE_ALIASES]);
    const folders = availableFolders(ctx, session.rows[0] ?? []);
    const body = folders.length === 0
      ? html`<p class="note">Não há subpastas de <code>sites/</code> sem cadastro. Para criar uma fonte, envie uma subpasta nova ao repositório
(nome só com letras minúsculas, números e hífen) e publique de novo.</p>`
      : html`<form method="post"><label for="alias">Subpasta de sites/</label>
<select id="alias" name="alias">${folders.map((folder) => html`<option>${folder}</option>`)}</select>
${sourceFields({ public: false, props: {}, render: ["html"] })}<div class="row"><button>Cadastrar</button></div></form>`;
    return adminPage(session, url, "Cadastrar fonte", body);
  });

  route("POST", "/admin/create-source", async (request) => {
    await enter(request, "admin");
    const form = await request.formData();
    const alias = text(form, "alias");
    await createSource(ctx, { alias, public: form.has("public"), props: text(form, "props"), render: text(form, "render") });
    return done(`/admin/edit-source?source=${encodeURIComponent(alias)}`, "Fonte cadastrada.");
  });

  route("GET", "/admin/edit-source", async (request, url) => {
    const alias = url.searchParams.get("source") ?? "";
    const session = await enter(request, "admin", () => [sourceQuery(alias)]);
    const source = oneSource(ctx, session.rows[0] ?? []);
    const body = html`<p>Endereço: <a href="/reader/view/${source.alias}/"><code>/reader/view/${source.alias}/</code></a> ·
<a href="/admin/list-readers?source=${source.alias}">${source.readers} leitor(es) com permissão</a></p>
${source.missing ? html`<p class="note bad">A subpasta <code>sites/${source.alias}/</code> não existe nesta publicação: a fonte responde "não encontrado".
Devolva a pasta ao repositório ou remova este cadastro.</p>` : ""}
<form method="post"><input type="hidden" name="action" value="save">${sourceFields(source)}<div class="row"><button>Salvar</button></div></form>
<h2>Remover</h2><p class="soft">Apaga a configuração e as permissões. Os arquivos continuam na pasta do repositório.</p>
<form method="post"><input type="hidden" name="action" value="delete"><button class="danger">Remover fonte</button></form>`;
    return adminPage(session, url, `Fonte ${source.alias}`, body);
  });

  route("POST", "/admin/edit-source", async (request, url) => {
    await enter(request, "admin");
    const alias = url.searchParams.get("source") ?? "";
    const form = await request.formData();
    if (text(form, "action") === "delete") {
      await deleteSource(ctx, alias);
      return done("/admin/list-sources", "Fonte removida.");
    }
    await updateSource(ctx, alias, { public: form.has("public"), props: text(form, "props"), render: text(form, "render") });
    return done(`/admin/edit-source?source=${encodeURIComponent(alias)}`, "Fonte salva.");
  });

  // Leitores e administradores: as mesmas telas, com as fontes a mais no leitor.

  for (const role of ["reader", "admin"] as const) {
    const plural = role === "reader" ? "readers" : "admins";
    const label = role === "reader" ? "leitor" : "administrador";
    const title = role === "reader" ? "Leitores" : "Administradores";
    const idParam = `${role}-id`;
    const editPath = (id: string): string => `/admin/edit-${role}?${idParam}=${encodeURIComponent(id)}`;

    route("GET", `/admin/list-${plural}`, async (request, url) => {
      const session = await enter(request, "admin", () => [listAccountsQuery(role, url.searchParams), ...(role === "reader" ? [SOURCE_ALIASES] : [])]);
      const list = accountsPage(session.rows[0] ?? [], url.searchParams);
      const value = (name: string): string => url.searchParams.get(name) ?? "";
      const filters = role === "reader"
        ? html`<div><label for="source">Fonte</label><select id="source" name="source"><option value="">Todas</option>
${(session.rows[1] ?? []).map((row) => html`<option ${row.alias === value("source") ? "selected" : ""}>${String(row.alias)}</option>`)}</select></div>
<div><label for="from">Criado desde</label><input type="date" id="from" name="created_from" value="${value("created_from")}"></div>
<div><label for="to">Criado até</label><input type="date" id="to" name="created_to" value="${value("created_to")}"></div>`
        : "";
      const body = html`<p><a href="/admin/create-${role}">Cadastrar ${label}</a></p>
<form method="get" class="row"><div><label for="q">Usuário começa com</label><input type="text" id="q" name="q" value="${value("q")}"></div>
${filters}<button class="plain">Filtrar</button></form>
<div class="scroll"><table><tr><th>Usuário</th>${role === "reader" ? html`<th>Fontes liberadas</th>` : ""}<th>Criado em (UTC)</th></tr>
${list.items.map((account) => html`<tr><td><a href="${editPath(account.id)}">${account.username}</a></td>
${role === "reader" ? html`<td>${account.sources}</td>` : ""}<td>${date(account.created_at)}</td></tr>`)}</table></div>
${list.items.length === 0 ? html`<p class="soft">Ninguém encontrado.</p>` : ""}${pager(url, list.page, list.hasNext)}`;
      return adminPage(session, url, title, body);
    });

    route("GET", `/admin/create-${role}`, async (request, url) => {
      const session = await enter(request, "admin");
      const body = html`<form method="post" class="narrow"><label for="username">Usuário</label>
<input type="text" id="username" name="username" autocomplete="off" required>
<label for="password">Senha <small>mínimo de 8 caracteres</small></label>
<input type="password" id="password" name="password" autocomplete="new-password" required>
<div class="row"><button>Cadastrar</button></div></form>
${role === "admin" ? html`<p class="note warn">Um administrador pode tudo, inclusive remover os outros administradores.</p>` : ""}`;
      return adminPage(session, url, `Cadastrar ${label}`, body);
    });

    route("POST", `/admin/create-${role}`, async (request) => {
      await enter(request, "admin");
      const form = await request.formData();
      const account = await createAccount(ctx, role, { username: text(form, "username"), password: text(form, "password") });
      return done(editPath(account.id), `Cadastro de ${label} criado.`);
    });

    route("GET", `/admin/edit-${role}`, async (request, url) => {
      const id = url.searchParams.get(idParam) ?? "";
      const session = await enter(request, "admin", () => accountQueries(role, id));
      const account = oneAccount(session.rows);
      const allowed = new Set(account.allowed ?? []);
      const sources = role === "reader"
        ? html`<h2>Fontes liberadas</h2>${(session.rows[3] ?? []).map((row) => row.public === 1
            ? html`<label class="check"><input type="checkbox" checked disabled> ${String(row.alias)} <span class="soft">(pública: todos leem)</span></label>`
            : html`<label class="check"><input type="checkbox" name="sources" value="${String(row.alias)}" ${allowed.has(String(row.alias)) ? "checked" : ""}> ${String(row.alias)}</label>`)}
${(session.rows[3] ?? []).length === 0 ? html`<p class="soft">Nenhuma fonte cadastrada ainda.</p>` : ""}`
        : "";
      const keys = role === "reader" && account.api_keys.length > 0
        ? html`<h2>Chaves de API do leitor</h2><div class="scroll"><table>${account.api_keys.map((key) => html`<tr><td><code>${key.id}</code></td><td>${date(key.created_at)}</td>
<td><form method="post"><input type="hidden" name="action" value="revoke-key"><input type="hidden" name="key" value="${key.id}"><button class="danger">Revogar</button></form></td></tr>`)}</table></div>`
        : "";
      const body = html`<form method="post"><input type="hidden" name="action" value="save">
<div class="narrow"><label for="username">Usuário</label><input type="text" id="username" name="username" value="${account.username}" autocomplete="off" required>
<label for="password">Nova senha <small>em branco mantém a atual</small></label>
<input type="password" id="password" name="password" autocomplete="new-password"></div>
<p class="soft">Trocar a senha encerra todas as sessões abertas deste usuário.</p>${sources}
<div class="row"><button>Salvar</button></div></form>${keys}
<h2>Remover</h2><p class="soft">Apaga a conta, as sessões e as chaves de API${role === "reader" ? " e as permissões" : ""}.</p>
<form method="post"><input type="hidden" name="action" value="delete"><button class="danger">Remover ${label}</button></form>`;
      return adminPage(session, url, `${role === "reader" ? "Leitor" : "Administrador"} ${account.username}`, body);
    });

    route("POST", `/admin/edit-${role}`, async (request, url) => {
      const session = await enter(request, "admin");
      const id = url.searchParams.get(idParam) ?? "";
      const form = await request.formData();
      const action = text(form, "action");
      if (action === "delete") {
        await deleteAccount(ctx, role, id);
        // Quem remove a própria conta perde a sessão junto: volta ao login.
        return role === "admin" && id === session.user.id ? redirect("/admin/") : done(`/admin/list-${plural}`, "Conta removida.");
      }
      if (action === "revoke-key" && role === "reader") {
        await deleteApiKey(ctx, "reader", id, text(form, "key"));
        return done(editPath(id), "Chave revogada.");
      }
      await updateAccount(ctx, role, id, {
        username: text(form, "username"),
        password: text(form, "password"),
        ...(role === "reader" ? { sources: form.getAll("sources").filter((item) => typeof item === "string") } : {}),
      });
      return done(editPath(id), "Alterações salvas.");
    });
  }

  // -------------------------------------------------------------------------
  // Leitor
  // -------------------------------------------------------------------------

  route("GET", "/reader/home", async (request, url) => {
    const session = await enter(request, "reader", (user) => [readableSourcesQuery(user)]);
    const sources = readableSources(session.rows[0]);
    const body = html`${sources.length === 0 ? html`<p class="note">Nenhuma fonte está liberada para você ainda.</p>` : ""}
<ul class="cards">${sources.map((source) => html`<li><a href="/reader/view/${source.alias}/"><strong>${source.alias}</strong><br>
<span class="soft">${source.public ? "Pública" : "Liberada para você"}</span></a></li>`)}</ul>
<p><a href="/reader/config">Personalizar a interface (meus props)</a> · <a href="/reader/api-keys">Chaves de API</a></p>`;
    return page({ title: "Suas fontes", body, role: "reader", username: session.user.username, url });
  });

  route("GET", "/reader/config", async (request, url) => {
    const session = await enter(request, "reader");
    const body = html`<p>Seus props personalizam as páginas que você lê. Eles vencem os props da plataforma e os da fonte quando têm a mesma chave.</p>
<form method="post"><label for="props">JSON</label><textarea id="props" name="props" spellcheck="false">${pretty(session.user.props)}</textarea>
<div class="row"><button>Salvar</button></div></form>`;
    return page({ title: "Meus props", body, role: "reader", username: session.user.username, url });
  });

  route("POST", "/reader/config", async (request) => {
    const session = await enter(request, "reader");
    await setReaderProps(ctx, session.user.id, text(await request.formData(), "props"));
    return done("/reader/config", "Props salvos.");
  });

  route("GET", "/reader/view/:alias", (request, _url, params) => view(ctx, request, params.alias ?? "", "", "page"));
  route("GET", "/reader/view/:alias/*", (request, _url, params) => view(ctx, request, params.alias ?? "", params["*"] ?? "", "page"));

  // -------------------------------------------------------------------------
  // Root
  // -------------------------------------------------------------------------

  route("GET", "/root/setup", async (_request, url) => {
    const body = html`<p>Esta página cria e remove administradores usando a senha root. Use-a para criar o primeiro administrador
ou para recuperar o acesso.</p>
<dialog id="ask"><form method="dialog"><label for="root-password">Senha root</label>
<input type="password" id="root-password" autocomplete="off" required><div class="row"><button>Continuar</button></div></form></dialog>
<p id="message" class="note" hidden></p>
<div id="panel" hidden><h2>Criar administrador</h2>
<form id="create" class="narrow"><label for="username">Usuário</label><input type="text" id="username" autocomplete="off" required>
<label for="password">Senha <small>mínimo de 8 caracteres</small></label><input type="password" id="password" autocomplete="new-password" required>
<div class="row"><button>Criar</button></div></form>
<h2>Administradores</h2><div class="scroll"><table id="admins"></table></div></div>
<noscript><p class="note bad">Esta página precisa de JavaScript.</p></noscript>`;
    return page({ title: "Configuração root", body, url, script: "/root/setup.js" });
  });

  server.route("GET", "/root/setup.js", () =>
    new Response(ROOT_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } }));
}
