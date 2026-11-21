// The API: everything the pages do, in JSON.
//
//   /api/admin/*    administrator cookie or a "cn_a_..." key
//   /api/reader/*   reader cookie or a "cn_r_..." key
//   /api/root/*     root password in the X-Root-Password header
//   /api/reader/invite/:token   no sign-in: the access link is the credential
//
// The key goes in the `Authorization: Bearer <key>` header. Without valid
// authentication the answer is 401; the API never redirects to the login.
import type { Server } from "../deps/server.ts";
import {
  type Ctx, HttpError, type Invite, PLATFORM_PROPS, Reply, type Session, type Statement, type UserRef, acceptInvite, accountQueries, accountsPage,
  apiKeys, apiKeysQuery, auditPage, createAccount, createApiKey, createInvite, deleteAccount, deleteApiKey, deleteSource, findInvite,
  identify, inviteUrl, ipOf, listAccountsQuery, listAuditQuery, listSourcesQuery, login, logout, oneAccount, oneSource, platformProps, readableSources,
  readableSourcesQuery, requireRoot, revokeInvite, setPlatformProps, setReaderProps, sourceQuery, sourcesPage, syncSources, updateAccount, updateSource,
} from "./core.ts";
import { rootActor } from "./audit.ts";
import type { Role } from "./security.ts";
import { view } from "./view.ts";

type Method = "GET" | "POST" | "PUT" | "DELETE";
type ApiHandler = (request: Request, url: URL, params: Record<string, string>) => Promise<Response | object>;

const NO_STORE = { "cache-control": "no-store" };

/** An access link as the API answers it: the full address, and when it stops working. */
function inviteJson(ctx: Ctx, request: Request, invite: Invite): { url: string; expires_at: number } {
  return { url: inviteUrl(ctx, request, invite.token), expires_at: invite.expires_at };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "The request body must be JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "The request body must be a JSON object.");
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

  /** For administrators, the folders of sites/sources/ get their rows before anything is read. */
  const enter = async (request: Request, role: Role, reads?: (user: UserRef) => Statement[]): Promise<Session> => {
    const sync = role === "admin" ? syncSources(ctx) : [];
    const { session } = await identify(ctx, request, role, { allowKey: true, reads: (user) => [...sync, ...(reads?.(user) ?? [])] });
    if (!session) throw new HttpError(401, "Not authenticated.");
    return { ...session, rows: session.rows.slice(sync.length) };
  };

  // Common to both roles ------------------------------------------------------

  for (const role of ["admin", "reader"] as const) {
    route("POST", `/api/${role}/login`, async (request) => {
      const result = await login(ctx, request, role, await body(request));
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

    // The response carries `key`, the key itself. It is the only time it appears.
    route("POST", `/api/${role}/api-keys`, async (request) => {
      const session = await enter(request, role);
      return Response.json(await createApiKey(ctx, session.actor, role, session.user.id), { status: 201, headers: NO_STORE });
    });

    route("DELETE", `/api/${role}/api-keys/:id`, async (request, _url, params) => {
      const session = await enter(request, role);
      await deleteApiKey(ctx, session.actor, role, session.user.id, params.id ?? "");
      return { ok: true };
    });
  }

  // Administrator ------------------------------------------------------------

  route("GET", "/api/admin/config", async (request) => {
    const session = await enter(request, "admin", () => [PLATFORM_PROPS]);
    return { props: platformProps(session.rows[0]) };
  });

  route("PUT", "/api/admin/config", async (request) => {
    const { actor } = await enter(request, "admin");
    await setPlatformProps(ctx, actor, (await body(request)).props);
    return { ok: true };
  });

  // Sources are the folders of sites/sources/: there is nothing to create here.
  // Filters: q, created_from, created_to, min_readers, page.
  route("GET", "/api/admin/sources", async (request, url) => {
    const session = await enter(request, "admin", () => [listSourcesQuery(url.searchParams)]);
    return sourcesPage(ctx, session.rows[0] ?? [], url.searchParams);
  });

  route("GET", "/api/admin/sources/:alias", async (request, _url, params) => {
    const session = await enter(request, "admin", () => [sourceQuery(params.alias ?? "")]);
    return oneSource(ctx, session.rows[0] ?? []);
  });

  // The only field is `public`: props and rendered extensions come from the source's source.json.
  route("PUT", "/api/admin/sources/:alias", async (request, _url, params) => {
    const { actor } = await enter(request, "admin");
    await updateSource(ctx, actor, params.alias ?? "", await body(request));
    return { ok: true };
  });

  // Only for a source whose folder is no longer published.
  route("DELETE", "/api/admin/sources/:alias", async (request, _url, params) => {
    const { actor } = await enter(request, "admin");
    await deleteSource(ctx, actor, params.alias ?? "");
    return { ok: true };
  });

  for (const role of ["reader", "admin"] as const) {
    const base = `/api/admin/${role}s`;

    // Filters: q, page and, for readers, source, created_from, created_to.
    route("GET", base, async (request, url) => {
      const session = await enter(request, "admin", () => [listAccountsQuery(role, url.searchParams)]);
      return accountsPage(session.rows[0] ?? [], url.searchParams);
    });

    // Administrators: username and password. Readers: username and email; the answer
    // carries `invite.url`, the link through which the reader chooses the password.
    // It is the only time that link appears.
    route("POST", base, async (request) => {
      const { actor } = await enter(request, "admin");
      const { invite, ...account } = await createAccount(ctx, actor, role, await body(request));
      return Response.json({ ...account, ...(invite ? { invite: inviteJson(ctx, request, invite) } : {}) }, { status: 201, headers: NO_STORE });
    });

    route("GET", `${base}/:id`, async (request, _url, params) => {
      const session = await enter(request, "admin", () => accountQueries(role, params.id ?? ""));
      return oneAccount(session.rows);
    });

    // Optional fields. Administrators: username, password. Readers: username, email,
    // sources (the complete list of granted aliases); never a password.
    route("PUT", `${base}/:id`, async (request, _url, params) => {
      const { actor } = await enter(request, "admin");
      await updateAccount(ctx, actor, role, params.id ?? "", await body(request));
      return { ok: true };
    });

    route("DELETE", `${base}/:id`, async (request, _url, params) => {
      const { actor } = await enter(request, "admin");
      await deleteAccount(ctx, actor, role, params.id ?? "");
      return { ok: true };
    });
  }

  route("DELETE", "/api/admin/readers/:id/api-keys/:key", async (request, _url, params) => {
    const { actor } = await enter(request, "admin");
    await deleteApiKey(ctx, actor, "reader", params.id ?? "", params.key ?? "");
    return { ok: true };
  });

  // A new access link for the reader, replacing the one before it: for a reader who
  // never chose a password, or to let one choose a new password.
  route("POST", "/api/admin/readers/:id/invite", async (request, _url, params) => {
    const { actor } = await enter(request, "admin");
    return Response.json(inviteJson(ctx, request, await createInvite(ctx, actor, params.id ?? "")), { status: 201, headers: NO_STORE });
  });

  route("DELETE", "/api/admin/readers/:id/invite", async (request, _url, params) => {
    const { actor } = await enter(request, "admin");
    await revokeInvite(ctx, actor, params.id ?? "");
    return { ok: true };
  });

  // Every change made to the database, newest first. Filters: action, action_prefix, actor (name prefix),
  // actor_id, target, created_from, created_to. The answer carries `next_before`: send it as `before` for the older entries.
  route("GET", "/api/admin/audit", async (request, url) => {
    const session = await enter(request, "admin", () => [listAuditQuery(url.searchParams)]);
    return auditPage(session.rows[0] ?? []);
  });

  // Reader -------------------------------------------------------------------

  route("GET", "/api/reader/sources", async (request) => {
    const session = await enter(request, "reader", (user) => [readableSourcesQuery(user)]);
    return { items: readableSources(session.rows[0]) };
  });

  route("GET", "/api/reader/props", async (request) => ({ props: (await enter(request, "reader")).user.props }));

  route("PUT", "/api/reader/props", async (request) => {
    const session = await enter(request, "reader");
    await setReaderProps(ctx, session.actor, session.user.id, (await body(request)).props);
    return { ok: true };
  });

  // The access link: who it is for, and choosing the password (`{ "password": "..." }`),
  // which signs the reader in. The link works once.
  route("GET", "/api/reader/invite/:token", async (_request, _url, params) => {
    const { username, expires_at } = await findInvite(ctx, params.token ?? "");
    return { username, expires_at };
  });

  route("POST", "/api/reader/invite/:token", async (request, _url, params) => {
    const result = await acceptInvite(ctx, request, params.token ?? "", await body(request));
    return Response.json({ user: result.user }, { headers: { ...NO_STORE, "set-cookie": result.cookie } });
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
    return Response.json(await createAccount(ctx, rootActor(ipOf(ctx, request)), "admin", await body(request)), { status: 201, headers: NO_STORE });
  });

  route("DELETE", "/api/root/admins/:id", async (request, _url, params) => {
    await requireRoot(ctx, request);
    await deleteAccount(ctx, rootActor(ipOf(ctx, request)), "admin", params.id ?? "");
    return { ok: true };
  });
}
