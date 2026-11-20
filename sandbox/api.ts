// A API (seed.md, seção 11): tudo o que as páginas fazem, em JSON.
//
//   /api/admin/*    cookie de administrador ou chave "cn_a_..."
//   /api/reader/*   cookie de leitor ou chave "cn_r_..."
//   /api/root/*     senha root no cabeçalho X-Root-Password
//
// A chave vai no cabeçalho `Authorization: Bearer <chave>`. Sem autenticação
// válida a resposta é 401; a API nunca redireciona para o login.
import type { Server } from "../deps/server.ts";
import {
  type Ctx, HttpError, PLATFORM_PROPS, Reply, SOURCE_ALIASES, type Session, type Statement, type UserRef, accountQueries, accountsPage,
  apiKeys, apiKeysQuery, availableFolders, createAccount, createApiKey, createSource, deleteAccount, deleteApiKey, deleteSource,
  identify, listAccountsQuery, listSourcesQuery, login, logout, oneAccount, oneSource, platformProps, readableSources,
  readableSourcesQuery, requireRoot, setPlatformProps, setReaderProps, sourceQuery, sourcesPage, updateAccount, updateSource,
} from "./core.ts";
import type { Role } from "./security.ts";
import { view } from "./view.ts";

type Method = "GET" | "POST" | "PUT" | "DELETE";
type ApiHandler = (request: Request, url: URL, params: Record<string, string>) => Promise<Response | object>;

const NO_STORE = { "cache-control": "no-store" };

async function body(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "O corpo da requisição deve ser JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "O corpo da requisição deve ser um objeto JSON.");
  return parsed as Record<string, unknown>;
}

export function registerApi(server: Server, ctx: Ctx): void {
  const route = (method: Method, path: string, handler: ApiHandler): void => {
    server.route(method, path, async (request, params) => {
      try {
        const result = await handler(request, new URL(request.url), params);
        return result instanceof Response ? result : Response.json(result, { headers: NO_STORE });
      } catch (error) {
        if (error instanceof Reply) return error.response;
        if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
        throw error;
      }
    });
  };

  const enter = async (request: Request, role: Role, reads?: (user: UserRef) => Statement[]): Promise<Session> => {
    const { session } = await identify(ctx, request, role, { allowKey: true, reads });
    if (!session) throw new HttpError(401, "Não autenticado.");
    return session;
  };

  // Comum aos dois papéis ----------------------------------------------------

  for (const role of ["admin", "reader"] as const) {
    route("POST", `/api/${role}/login`, async (request) => {
      const result = await login(ctx, role, await body(request));
      return Response.json({ user: result.user }, { headers: { ...NO_STORE, "set-cookie": result.cookie } });
    });

    route("POST", `/api/${role}/logout`, async (request) =>
      Response.json({ ok: true }, { headers: { ...NO_STORE, "set-cookie": await logout(ctx, request, role) } }));

    route("GET", `/api/${role}/me`, async (request) => {
      const { user } = await enter(request, role);
      return role === "reader" ? user : { id: user.id, username: user.username };
    });

    route("GET", `/api/${role}/api-keys`, async (request) => {
      const session = await enter(request, role, (user) => [apiKeysQuery(role, user)]);
      return { items: apiKeys(session.rows[0]) };
    });

    // A resposta traz `key`, a chave em si. É a única vez em que ela aparece.
    route("POST", `/api/${role}/api-keys`, async (request) => {
      const session = await enter(request, role);
      return Response.json(await createApiKey(ctx, role, session.user.id), { status: 201, headers: NO_STORE });
    });

    route("DELETE", `/api/${role}/api-keys/:id`, async (request, _url, params) => {
      const session = await enter(request, role);
      await deleteApiKey(ctx, role, session.user.id, params.id ?? "");
      return { ok: true };
    });
  }

  // Administrador ------------------------------------------------------------

  route("GET", "/api/admin/config", async (request) => {
    const session = await enter(request, "admin", () => [PLATFORM_PROPS]);
    return { props: platformProps(session.rows[0]) };
  });

  route("PUT", "/api/admin/config", async (request) => {
    await enter(request, "admin");
    await setPlatformProps(ctx, (await body(request)).props);
    return { ok: true };
  });

  // Filtros: q, created_from, created_to, min_readers, page.
  route("GET", "/api/admin/sources", async (request, url) => {
    const session = await enter(request, "admin", () => [listSourcesQuery(url.searchParams)]);
    return sourcesPage(ctx, session.rows[0] ?? [], url.searchParams);
  });

  // Subpastas de sites/ que ainda podem ser cadastradas.
  route("GET", "/api/admin/available-sources", async (request) => {
    const session = await enter(request, "admin", () => [SOURCE_ALIASES]);
    return { items: availableFolders(ctx, session.rows[0] ?? []) };
  });

  route("POST", "/api/admin/sources", async (request) => {
    await enter(request, "admin");
    await createSource(ctx, await body(request));
    return Response.json({ ok: true }, { status: 201, headers: NO_STORE });
  });

  route("GET", "/api/admin/sources/:alias", async (request, _url, params) => {
    const session = await enter(request, "admin", () => [sourceQuery(params.alias ?? "")]);
    return oneSource(ctx, session.rows[0] ?? []);
  });

  route("PUT", "/api/admin/sources/:alias", async (request, _url, params) => {
    await enter(request, "admin");
    await updateSource(ctx, params.alias ?? "", await body(request));
    return { ok: true };
  });

  route("DELETE", "/api/admin/sources/:alias", async (request, _url, params) => {
    await enter(request, "admin");
    await deleteSource(ctx, params.alias ?? "");
    return { ok: true };
  });

  for (const role of ["reader", "admin"] as const) {
    const base = `/api/admin/${role}s`;

    // Filtros: q, page e, para leitores, source, created_from, created_to.
    route("GET", base, async (request, url) => {
      const session = await enter(request, "admin", () => [listAccountsQuery(role, url.searchParams)]);
      return accountsPage(session.rows[0] ?? [], url.searchParams);
    });

    route("POST", base, async (request) => {
      await enter(request, "admin");
      return Response.json(await createAccount(ctx, role, await body(request)), { status: 201, headers: NO_STORE });
    });

    route("GET", `${base}/:id`, async (request, _url, params) => {
      const session = await enter(request, "admin", () => accountQueries(role, params.id ?? ""));
      return oneAccount(session.rows);
    });

    // Campos opcionais: username, password e, para leitores, sources (lista completa de aliases liberados).
    route("PUT", `${base}/:id`, async (request, _url, params) => {
      await enter(request, "admin");
      await updateAccount(ctx, role, params.id ?? "", await body(request));
      return { ok: true };
    });

    route("DELETE", `${base}/:id`, async (request, _url, params) => {
      await enter(request, "admin");
      await deleteAccount(ctx, role, params.id ?? "");
      return { ok: true };
    });
  }

  route("DELETE", "/api/admin/readers/:id/api-keys/:key", async (request, _url, params) => {
    await enter(request, "admin");
    await deleteApiKey(ctx, "reader", params.id ?? "", params.key ?? "");
    return { ok: true };
  });

  // Leitor -------------------------------------------------------------------

  route("GET", "/api/reader/sources", async (request) => {
    const session = await enter(request, "reader", (user) => [readableSourcesQuery(user)]);
    return { items: readableSources(session.rows[0]) };
  });

  route("GET", "/api/reader/props", async (request) => ({ props: (await enter(request, "reader")).user.props }));

  route("PUT", "/api/reader/props", async (request) => {
    const session = await enter(request, "reader");
    await setReaderProps(ctx, session.user.id, (await body(request)).props);
    return { ok: true };
  });

  route("GET", "/api/reader/view/:alias", (request, _url, params) => view(ctx, request, params.alias ?? "", "", "api"));
  route("GET", "/api/reader/view/:alias/*", (request, _url, params) => view(ctx, request, params.alias ?? "", params["*"] ?? "", "api"));

  // Root ---------------------------------------------------------------------

  route("GET", "/api/root/admins", async (request, url) => {
    await requireRoot(ctx, request);
    return accountsPage(await ctx.db.query(...listAccountsQuery("admin", url.searchParams)), url.searchParams);
  });

  route("POST", "/api/root/admins", async (request) => {
    await requireRoot(ctx, request);
    return Response.json(await createAccount(ctx, "admin", await body(request)), { status: 201, headers: NO_STORE });
  });

  route("DELETE", "/api/root/admins/:id", async (request, _url, params) => {
    await requireRoot(ctx, request);
    await deleteAccount(ctx, "admin", params.id ?? "");
    return { ok: true };
  });
}
