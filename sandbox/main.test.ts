import type { App, Tests } from "../deps/testing.ts";
import { safeNext } from "./pages.ts";
import { render } from "./template.ts";

// Valores inventados: os testes nunca veem os segredos de verdade.
const ROOT = "senha-root-de-teste";
const secrets = { CANONE_ROOT_PASSWORD: ROOT, CANONE_MASTER_KEY: "chave-mestra-de-teste", CANONE_SIGNING_KEY: "chave-de-assinatura-de-teste" };
const JSON_HEADERS = { "content-type": "application/json" };

export default function ({ test, assert }: Tests) {
  const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method,
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });

  /** O cookie de sessão devolvido por um login, pronto para o cabeçalho `cookie`. */
  const cookieOf = (response: Response): string => (response.headers.getSetCookie()[0] ?? "").split(";")[0]!;

  const createAdmin = async (app: App, username = "ana", password = "senha-da-ana"): Promise<string> => {
    const created = await app.fetch("/api/root/admins", json("POST", { username, password }, { "x-root-password": ROOT }));
    assert.equal(created.status, 201);
    const login = await app.fetch("/api/admin/login", json("POST", { username, password }));
    assert.equal(login.status, 200);
    return cookieOf(login);
  };

  const createReader = async (app: App, admin: string, username = "leo", password = "senha-do-leo"): Promise<{ id: string; cookie: string }> => {
    const created = await app.fetch("/api/admin/readers", json("POST", { username, password }, { cookie: admin }));
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    const login = await app.fetch("/api/reader/login", json("POST", { username, password }));
    return { id, cookie: cookieOf(login) };
  };

  /** Cadastra a fonte `exemplo` (a pasta que vem no template). Devolve `false` se a instalação a removeu. */
  const registerExample = async (app: App, admin: string, settings: Record<string, unknown> = {}): Promise<boolean> => {
    const available = (await (await app.fetch("/api/admin/available-sources", { headers: { cookie: admin } })).json()) as { items: string[] };
    if (!available.items.includes("exemplo")) return false;
    const created = await app.fetch("/api/admin/sources", json("POST", { alias: "exemplo", ...settings }, { cookie: admin }));
    assert.equal(created.status, 201);
    return true;
  };

  // -------------------------------------------------------------------------
  // Engine de templates
  // -------------------------------------------------------------------------

  test("template: variáveis, if/else, laços e bloco cru", () => {
    const scope = { props: { site: "meu.site", age: 30, itens: ["a", "b"] }, query: { page: "2" }, headers: { "accept-language": "pt-BR" } };
    assert.equal(render("{{ props.site }}|{{ query.page }}|{{ headers.accept-language }}", scope), "meu.site|2|pt-BR");
    assert.equal(render("{% if props.age >= 18 %}adulto{% else %}restrito{% endif %}", scope), "adulto");
    assert.equal(render("{% if props.age < 18 %}a{% elsif query.page == 2 %}b{% else %}c{% endif %}", scope), "b");
    assert.equal(render("{% for i in props.itens %}{{ forloop.index }}{{ i }}{% endfor %}", scope), "1a2b");
    assert.equal(render("{% for i in props.nada %}x{% else %}vazio{% endfor %}", scope), "vazio");
    assert.equal(render("{% raw %}{{ props.site }}{% if %}{% endraw %}", scope), "{{ props.site }}{% if %}");
  });

  test("template: escapa por padrão e não alcança nada além dos dados", () => {
    const scope = { props: { nome: `<script>alert("x")</script>` } };
    assert.equal(render("{{ props.nome }}", scope), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    assert.equal(render("{{ props.nome | raw }}", scope), `<script>alert("x")</script>`);
    assert.equal(render("{{ props.constructor }}{{ props.__proto__ }}{{ props.nome.constructor }}", scope), "");
    let message = "";
    try {
      render("linha 1\n{% if props.nome %}sem fim", scope);
    } catch (error) {
      message = (error as Error).message;
    }
    assert(message.includes("linha 2"), message);
  });

  test("o endereço de retorno do login só aceita caminhos internos de fonte", () => {
    assert.equal(safeNext("/reader/view/exemplo/index.html?page=2"), "/reader/view/exemplo/index.html?page=2");
    for (const bad of ["https://site-falso", "//site-falso", "/reader/view//site-falso", "/reader/view/a\\b", "/admin/home", "/reader/home", "", null]) {
      assert.equal(safeNext(bad), null);
    }
  });

  // -------------------------------------------------------------------------
  // Root e login
  // -------------------------------------------------------------------------

  test("root: senha errada é recusada e o limite de tentativas bloqueia até a senha certa", { secrets }, async (app) => {
    assert.equal((await app.fetch("/root/setup")).status, 200);
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await app.fetch("/api/root/admins", { headers: { "x-root-password": "errada" } })).status, 401);
    }
    assert.equal((await app.fetch("/api/root/admins", { headers: { "x-root-password": ROOT } })).status, 429);
  });

  test("root cria o primeiro administrador, que entra com cookie protegido", { secrets }, async (app) => {
    assert.equal((await app.fetch("/admin/home")).headers.get("location"), "/admin/");
    const created = await app.fetch("/api/root/admins", json("POST", { username: "ana", password: "senha-da-ana" }, { "x-root-password": ROOT }));
    assert.equal(created.status, 201);

    const wrong = await app.fetch("/admin/", { method: "POST", body: new URLSearchParams({ username: "ana", password: "outra-senha" }) });
    assert.equal(wrong.headers.getSetCookie().length, 0);
    assert((wrong.headers.get("location") ?? "").startsWith("/admin/?erro="));

    const login = await app.fetch("/admin/", { method: "POST", body: new URLSearchParams({ username: "ana", password: "senha-da-ana" }) });
    assert.equal(login.headers.get("location"), "/admin/home");
    const setCookie = login.headers.getSetCookie()[0] ?? "";
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax"]) assert(setCookie.includes(attribute), `falta ${attribute}`);

    const cookie = cookieOf(login);
    assert.equal((await app.fetch("/admin/home", { headers: { cookie } })).status, 200);
    assert.equal((await app.fetch("/admin/", { headers: { cookie } })).headers.get("location"), "/admin/home");
    // O cookie de administrador não vale como leitor.
    assert.equal((await app.fetch("/reader/home", { headers: { cookie } })).headers.get("location"), "/reader/");
  });

  test("logout só por POST, e o token deixa de valer na hora", { secrets }, async (app) => {
    const cookie = await createAdmin(app);
    assert.equal((await app.fetch("/admin/logout", { headers: { cookie } })).status, 405);
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie } })).status, 200);
    const out = await app.fetch("/admin/logout", { method: "POST", headers: { cookie } });
    assert.equal(out.headers.get("location"), "/admin/");
    assert((out.headers.getSetCookie()[0] ?? "").includes("Max-Age=0"));
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie } })).status, 401);
  });

  test("alteração com cookie vinda de outro site é recusada", { secrets }, async (app) => {
    const cookie = await createAdmin(app);
    const forged = await app.fetch("/api/admin/config", json("PUT", { props: { a: 1 } }, { cookie, origin: "https://site-falso.example" }));
    assert.equal(forged.status, 403);
    assert.equal((await app.fetch("/api/admin/config", json("PUT", { props: { a: 1 } }, { cookie }))).status, 200);
  });

  test("trocar a senha ou remover o usuário encerra as sessões e as chaves", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    const { key } = (await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string };
    assert.equal((await app.fetch("/api/reader/me", { headers: { authorization: `Bearer ${key}` } })).status, 200);

    await app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", { password: "senha-nova-do-leo" }, { cookie: admin }));
    assert.equal((await app.fetch("/api/reader/me", { headers: { cookie: leo.cookie } })).status, 401);
    // As chaves de API não são afetadas pela troca de senha, só pela remoção.
    assert.equal((await app.fetch("/api/reader/me", { headers: { authorization: `Bearer ${key}` } })).status, 200);

    const again = cookieOf(await app.fetch("/api/reader/login", json("POST", { username: "leo", password: "senha-nova-do-leo" })));
    assert.equal((await app.fetch("/api/reader/me", { headers: { cookie: again } })).status, 200);
    assert.equal((await app.fetch(`/api/admin/readers/${leo.id}`, { method: "DELETE", headers: { cookie: admin } })).status, 200);
    assert.equal((await app.fetch("/api/reader/me", { headers: { cookie: again } })).status, 401);
    assert.equal((await app.fetch("/api/reader/me", { headers: { authorization: `Bearer ${key}` } })).status, 401);
  });

  test("API: 401 sem autenticação, chave de cada papel só no próprio prefixo", { secrets }, async (app) => {
    assert.equal((await app.fetch("/api/admin/sources")).status, 401);
    assert.equal((await app.fetch("/api/reader/sources")).status, 401);
    const admin = await createAdmin(app);
    const leo = await createReader(app, admin);
    const adminKey = ((await (await app.fetch("/api/admin/api-keys", { method: "POST", headers: { cookie: admin } })).json()) as { key: string }).key;
    const readerKey = ((await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string }).key;
    assert.equal((await app.fetch("/api/admin/sources", { headers: { authorization: `Bearer ${adminKey}` } })).status, 200);
    assert.equal((await app.fetch("/api/admin/sources", { headers: { authorization: `Bearer ${readerKey}` } })).status, 401);
    assert.equal((await app.fetch("/api/reader/sources", { headers: { authorization: `Bearer ${adminKey}` } })).status, 401);

    // A listagem mostra o identificador, nunca a chave; revogada, ela para de valer.
    const list = (await (await app.fetch("/api/admin/api-keys", { headers: { cookie: admin } })).json()) as { items: Record<string, unknown>[] };
    assert.equal(Object.keys(list.items[0]!).sort(), ["created_at", "id"]);
    await app.fetch(`/api/admin/api-keys/${String(list.items[0]!.id)}`, { method: "DELETE", headers: { cookie: admin } });
    assert.equal((await app.fetch("/api/admin/sources", { headers: { authorization: `Bearer ${adminKey}` } })).status, 401);
  });

  test("cadastros inválidos são recusados com mensagem", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    const post = (path: string, body: unknown) => app.fetch(path, json("POST", body, { cookie: admin }));
    assert.equal((await post("/api/admin/readers", { username: "leo", password: "curta" })).status, 400);
    assert.equal((await post("/api/admin/readers", { username: "leo", password: "senha-do-leo" })).status, 201);
    assert.equal((await post("/api/admin/readers", { username: "leo", password: "senha-do-leo" })).status, 409);
    assert.equal((await post("/api/admin/sources", { alias: "pasta-que-nao-existe" })).status, 400);
    assert.equal((await post("/api/admin/sources", { alias: "../segredo" })).status, 400);
    assert.equal((await app.fetch("/api/admin/config", json("PUT", { props: [1, 2] }, { cookie: admin }))).status, 400);
  });

  // -------------------------------------------------------------------------
  // Leitura das fontes
  // -------------------------------------------------------------------------

  test("a pasta sites/ nunca é entregue direto, só pelo sistema", { secrets }, async (app) => {
    for (const path of ["/exemplo/index.html", "/exemplo/", "/exemplo/estilo.css", "/README.md", "/sites/exemplo/index.html"]) {
      const response = await app.fetch(path);
      assert(response.status === 404 || response.status === 405, `${path} respondeu ${response.status}`);
    }
  });

  test("fonte privada: login com retorno, sem acesso, e aliases que não se revelam", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    if (!(await registerExample(app, admin))) return;
    const page = "/reader/view/exemplo/index.html?page=7";
    const login = `/reader/?next=${encodeURIComponent(page)}`;

    // Visitante: alias privado e alias inexistente têm a mesma resposta.
    assert.equal((await app.fetch(page)).headers.get("location"), login);
    assert.equal((await app.fetch("/reader/view/nao-existe/index.html?page=7")).headers.get("location"), login.replace("exemplo", "nao-existe"));

    const created = await app.fetch("/api/admin/readers", json("POST", { username: "leo", password: "senha-do-leo" }, { cookie: admin }));
    const { id } = (await created.json()) as { id: string };
    const entered = await app.fetch(login, { method: "POST", body: new URLSearchParams({ username: "leo", password: "senha-do-leo" }) });
    assert.equal(entered.headers.get("location"), page);
    const cookie = cookieOf(entered);
    // Um `next` para fora é ignorado.
    const outside = await app.fetch("/reader/?next=https://site-falso.example", { headers: { cookie } });
    assert.equal(outside.headers.get("location"), "/reader/home");

    // Logado e sem permissão: "sem acesso", nunca de volta ao login. O mesmo para alias inexistente.
    assert.equal((await app.fetch(page, { headers: { cookie } })).status, 403);
    assert.equal((await app.fetch("/reader/view/nao-existe/", { headers: { cookie } })).status, 403);

    await app.fetch(`/api/admin/readers/${id}`, json("PUT", { sources: ["exemplo"] }, { cookie: admin }));
    const allowed = await app.fetch(page, { headers: { cookie } });
    assert.equal(allowed.status, 200);
    assert((await allowed.text()).includes("Página pedida na query (<code>?page=</code>): 7"));
    const home = await (await app.fetch("/reader/home", { headers: { cookie } })).text();
    assert(home.includes('href="/reader/view/exemplo/"'));

    // Revogar vale na hora.
    await app.fetch(`/api/admin/readers/${id}`, json("PUT", { sources: [] }, { cookie: admin }));
    assert.equal((await app.fetch(page, { headers: { cookie } })).status, 403);
  });

  test("props: plataforma < fonte < leitor, e credenciais nunca chegam ao template", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    await app.fetch("/api/admin/config", json("PUT", { props: { titulo: "Da plataforma", tema: "claro" } }, { cookie: admin }));
    if (!(await registerExample(app, admin, { public: true, props: { titulo: "Da <fonte>" } }))) return;

    // Visitante em fonte pública: só plataforma e fonte.
    const visitor = await (await app.fetch("/reader/view/exemplo/", { headers: { "accept-language": "pt-BR" } })).text();
    assert(visitor.includes("<h1>Da &lt;fonte&gt;</h1>"));
    assert(visitor.includes("Idioma do navegador: pt-BR"));
    assert(visitor.includes("Dentro de um bloco raw, {{ isto }} e {% isto %}"));
    assert(!visitor.includes("tema <strong>escuro</strong>"));

    const leo = await createReader(app, admin);
    await app.fetch("/api/reader/props", json("PUT", { props: { titulo: "Do leitor", tema: "escuro", avisos: ["um", "dois"] } }, { cookie: leo.cookie }));
    const reader = await (await app.fetch("/reader/view/exemplo/", { headers: { cookie: leo.cookie } })).text();
    assert(reader.includes("<h1>Do leitor</h1>"));
    assert(reader.includes("tema <strong>escuro</strong>"));
    assert(reader.includes("2. dois"));

    // Lista `render` vazia desliga a engine: o arquivo chega como foi escrito.
    await app.fetch("/api/admin/sources/exemplo", json("PUT", { render: [] }, { cookie: admin }));
    const raw = await (await app.fetch("/reader/view/exemplo/", { headers: { cookie: leo.cookie } })).text();
    assert(raw.includes('{{ props.titulo | default: "Exemplo do Canone" }}'));
  });

  test("arquivos: pasta vira index.html, o que não é template segue intacto, endereço que sai da pasta é recusado", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    if (!(await registerExample(app, admin, { public: true }))) return;
    assert.equal((await app.fetch("/reader/view/exemplo")).headers.get("location"), "/reader/view/exemplo/");
    assert.equal((await app.fetch("/reader/view/exemplo/sobre")).headers.get("location"), "/reader/view/exemplo/sobre/");
    assert((await (await app.fetch("/reader/view/exemplo/sobre/")).text()).includes("Sobre este exemplo"));
    assert.equal((await app.fetch("/reader/view/exemplo/nao-existe.html")).status, 404);

    const css = await app.fetch("/reader/view/exemplo/estilo.css");
    assert.equal(css.status, 200);
    assert((css.headers.get("content-type") ?? "").startsWith("text/css"));
    assert((await css.text()).includes("Este arquivo não passa pela engine"));
    const svg = await app.fetch("/reader/view/exemplo/img/logo.svg");
    assert((svg.headers.get("content-type") ?? "").startsWith("image/svg+xml"));
    await svg.arrayBuffer();

    for (const path of ["/reader/view/exemplo/..%2FREADME.md", "/reader/view/exemplo/.oculto", "/reader/view/exemplo/a%5Cb"]) {
      assert.equal((await app.fetch(path)).status, 400, path);
    }
  });

  test("API do leitor entrega arquivos com chave e respeita a permissão", { secrets }, async (app) => {
    const admin = await createAdmin(app);
    if (!(await registerExample(app, admin))) return;
    const leo = await createReader(app, admin);
    const { key } = (await (await app.fetch("/api/reader/api-keys", { method: "POST", headers: { cookie: leo.cookie } })).json()) as { key: string };
    const headers = { authorization: `Bearer ${key}` };
    assert.equal((await app.fetch("/api/reader/view/exemplo/index.html")).status, 401);
    assert.equal((await app.fetch("/api/reader/view/exemplo/index.html", { headers })).status, 403);
    await app.fetch(`/api/admin/readers/${leo.id}`, json("PUT", { sources: ["exemplo"] }, { cookie: admin }));
    const file = await app.fetch("/api/reader/view/exemplo/index.html", { headers });
    assert.equal(file.status, 200);
    // A chave não aparece para o template, mesmo vindo em um cabeçalho.
    assert(!(await file.text()).includes(key));
    assert.equal(await (await app.fetch("/api/reader/sources", { headers })).json(), { items: [{ alias: "exemplo", public: false }] });

    // Remover a fonte apaga a configuração e as permissões.
    assert.equal((await app.fetch("/api/admin/sources/exemplo", { method: "DELETE", headers: { cookie: admin } })).status, 200);
    assert.equal((await app.fetch("/api/reader/view/exemplo/index.html", { headers })).status, 403);
    const detail = (await (await app.fetch(`/api/admin/readers/${leo.id}`, { headers: { cookie: admin } })).json()) as { allowed: string[] };
    assert.equal(detail.allowed, []);
  });

  test("as páginas do administrador abrem e os formulários funcionam", { secrets }, async (app) => {
    const cookie = await createAdmin(app);
    const leo = await createReader(app, cookie);
    const pages = [
      "/admin/home", "/admin/config", "/admin/list-sources", "/admin/create-source", "/admin/list-readers?q=le", "/admin/create-reader",
      `/admin/edit-reader?reader-id=${leo.id}`, "/admin/list-admins", "/admin/create-admin", "/admin/api-keys",
    ];
    for (const path of pages) {
      const response = await app.fetch(path, { headers: { cookie } });
      assert.equal(response.status, 200, path);
      assert((await response.text()).includes(">Sair</button>"), `${path} sem o botão Sair`);
    }
    for (const path of ["/reader/home", "/reader/config", "/reader/api-keys"]) {
      assert.equal((await app.fetch(path, { headers: { cookie: leo.cookie } })).status, 200, path);
    }
    const saved = await app.fetch("/admin/config", { method: "POST", headers: { cookie }, body: new URLSearchParams({ props: '{"site": "meu.site"}' }) });
    assert((saved.headers.get("location") ?? "").startsWith("/admin/config?ok="));
    assert.equal(await (await app.fetch("/api/admin/config", { headers: { cookie } })).json(), { props: { site: "meu.site" } });
    const broken = await app.fetch("/admin/config", { method: "POST", headers: { cookie }, body: new URLSearchParams({ props: "{isto não é json" }) });
    assert((broken.headers.get("location") ?? "").startsWith("/admin/config?erro="));

    // A chave aparece uma vez, na resposta da geração.
    const generated = await (await app.fetch("/admin/api-keys", { method: "POST", headers: { cookie }, body: new URLSearchParams({ action: "create" }) })).text();
    const key = /cn_a_[A-Za-z0-9_-]+/.exec(generated)?.[0] ?? "";
    assert(key !== "");
    assert(!(await (await app.fetch("/admin/api-keys", { headers: { cookie } })).text()).includes(key));
  });

  test("a limpeza agendada apaga sessões vencidas", { secrets }, async (app) => {
    const cookie = await createAdmin(app);
    await app.runCron("2020-01-01T00:17:00Z");
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie } })).status, 200);
    await app.runCron("2090-01-01T00:17:00Z");
    assert.equal((await app.fetch("/api/admin/me", { headers: { cookie } })).status, 401);
  });
}
