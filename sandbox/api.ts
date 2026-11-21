// The API: everything the pages do, in JSON.
//
//   /api/admin/*    administrator cookie or a "cn_a_..." key
//   /api/reader/*   reader cookie or a "cn_r_..." key
//   /api/root/*     root password in the X-Root-Password header
//   /api/reader/invite/:token   no sign-in: the access link is the credential
//
// An administrator who turned on two-step verification signs in with
// `username`, `password` and `code` (the 6 digits of their authenticator app,
// as text). API keys are not affected: a key is its own credential.
//
// The key goes in the `Authorization: Bearer <key>` header. Without valid
// authentication the answer is 401; the API never redirects to the login.
//
// The files of a source are managed under /api/admin/sources/:alias/files:
// a script anywhere, holding an administrator key, publishes a site with one
// PUT for each file (the body of the request is the content of the file).
import type { Server } from "../deps/server.ts";
import {
  type Ctx, HttpError, type Invite, MAX_FILE_BYTES, PLATFORM_PROPS, Reply, type Session, type Statement, type UserRef, acceptInvite, accountQueries, accountsPage,
  apiKeys, apiKeysQuery, auditPage, createAccount, createApiKey, createInvite, createSource, deleteAccount, deleteApiKey, deleteFile, deleteSource, fileTargetQuery, filePath, filesPage, findInvite, listFilesQuery, putFile, readFile,
  identify, inviteUrl, ipOf, listAccountsQuery, POLICY, auditCsv, changeOwnPassword, exportAuditQueries, policy, setPolicy, setSuspended, listAuditQuery, listSourcesQuery, login, logout, oneAccount, oneSource, platformProps, readableSources,
  readableSourcesQuery, requireRoot, revokeInvite, confirmTwoStep, disableTwoStep, resetTwoStep, startTwoStep, twoStep, twoStepQuery, setPlatformProps, setReaderProps, sourceQuery, sourcesPage, updateAccount, updateSource,
} from "./core.ts";
import { rootActor } from "./audit.ts";
import { loadLabel } from "./label.ts";
import { type Role, mfaUrl } from "./security.ts";
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

/** For the routes whose body is optional: no body at all is an empty object. */
async function optionalBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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

  /** Requires the cookie or the key of the role. The reads share the same trip to the database. */
  const enter = async (request: Request, role: Role, reads?: (user: UserRef) => Statement[]): Promise<Session> => {
    const { session } = await identify(ctx, request, role, { allowKey: true, reads });
    if (!session) throw new HttpError(401, "Not authenticated.");
    return session;
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
    // Optional body: `name` (what the key is for) and `expires_in_days` (without it, the key works until revoked).
    route("POST", `/api/${role}/api-keys`, async (request) => {
      const session = await enter(request, role);
      return Response.json(await createApiKey(ctx, session.actor, role, session.user.id, await optionalBody(request)), { status: 201, headers: NO_STORE });
    });

    // One's own password: `current_password` and `new_password`. With the session cookie only, never with a key.
    // The other sessions of the account end.
    route("PUT", `/api/${role}/password`, async (request) => {
      await changeOwnPassword(ctx, await enter(request, role), await body(request));
      return { ok: true };
    });

    route("DELETE", `/api/${role}/api-keys/:id`, async (request, _url, params) => {
      const session = await enter(request, role);
      await deleteApiKey(ctx, session.actor, role, session.user.id, params.id ?? "");
      return { ok: true };
    });
  }

  // Administrator ------------------------------------------------------------

  // Two-step verification of one's own account, which each administrator turns on or leaves off. With the
  // session cookie only, never with a key. Turning it on takes two calls: `setup` (`current_password`) answers
  // with the key for the authenticator app, and `confirm` (`code`) proves the app has it.
  route("GET", "/api/admin/two-step", async (request) => {
    const session = await enter(request, "admin", (user) => [twoStepQuery(user)]);
    const { enabled, enabled_at, pending } = await twoStep(ctx, session, session.rows[0]);
    return { enabled, enabled_at, pending };
  });

  // The answer carries `secret`, the key to type into the app, and `url`, the same as an otpauth:// address.
  route("POST", "/api/admin/two-step/setup", async (request) => {
    const session = await enter(request, "admin");
    const { secret } = await startTwoStep(ctx, session, await body(request));
    return { secret, url: mfaUrl((await loadLabel(ctx.sites)).name, session.user.username, secret) };
  });

  route("POST", "/api/admin/two-step/confirm", async (request) => {
    await confirmTwoStep(ctx, await enter(request, "admin"), await body(request));
    return { ok: true };
  });

  // `current_password` when it is on; nothing when it is only a setup never confirmed.
  route("POST", "/api/admin/two-step/disable", async (request) => {
    await disableTwoStep(ctx, await enter(request, "admin"), await optionalBody(request));
    return { ok: true };
  });

  route("GET", "/api/admin/config", async (request) => {
    const session = await enter(request, "admin", () => [PLATFORM_PROPS]);
    return { props: platformProps(session.rows[0]) };
  });

  route("PUT", "/api/admin/config", async (request) => {
    const { actor } = await enter(request, "admin");
    await setPlatformProps(ctx, actor, (await body(request)).props);
    return { ok: true };
  });

  // Filters: q, created_from, created_to, min_readers, page. Each item says how many files and bytes the source
  // holds; its props and rendered extensions are in the answer for one source.
  route("GET", "/api/admin/sources", async (request, url) => {
    const session = await enter(request, "admin", () => [listSourcesQuery(url.searchParams)]);
    return sourcesPage(session.rows[0] ?? [], url.searchParams);
  });

  // `alias` (lowercase letters, digits and hyphens) and, optionally, `public`. The new source is empty: its
  // files are sent next, one PUT each.
  route("POST", "/api/admin/sources", async (request) => {
    const { actor } = await enter(request, "admin");
    return Response.json(await createSource(ctx, actor, await body(request)), { status: 201, headers: NO_STORE });
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

  // The source goes with its permissions and every one of its files. `files_pending` is how many stored files are
  // still being deleted in the background; none of them is served any more.
  route("DELETE", "/api/admin/sources/:alias", async (request, _url, params) => {
    const { actor } = await enter(request, "admin");
    return { ok: true, ...(await deleteSource(ctx, actor, params.alias ?? "")) };
  });

  // The files of a source, in path order. Filters: q (path prefix), limit (up to 1000) and after: the answer
  // carries `next_after` while there is more, to be sent as `after`. Registered before the routes that end
  // in `*`, which would also match this address.
  route("GET", "/api/admin/sources/:alias/files", async (request, url, params) => {
    const alias = params.alias ?? "";
    const session = await enter(request, "admin", () => [sourceQuery(alias), listFilesQuery(alias, url.searchParams)]);
    if (!session.rows[0]?.[0]) throw new HttpError(404, "Source not found.");
    return filesPage(session.rows[1] ?? [], url.searchParams);
  });

  // One file exactly as it was uploaded: no template, and always a download, because what a source holds is
  // a site of its own and must not open as a page of this console.
  route("GET", "/api/admin/sources/:alias/files/*", async (request, _url, params) => {
    const alias = params.alias ?? "";
    const path = filePath(params["*"] ?? "");
    const session = await enter(request, "admin", () => [fileTargetQuery(alias, path)]);
    const file = await readFile(ctx, session.rows[0]?.[0], path);
    return new Response(file.body, {
      headers: {
        ...NO_STORE,
        "content-type": file.headers.get("content-type") ?? "application/octet-stream",
        "content-disposition": "attachment",
        "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
        ...(file.headers.has("etag") ? { etag: file.headers.get("etag") ?? "" } : {}),
      },
    });
  });

  // Adds the file at this path, or replaces it: the body of the request is its content, up to 25 MB. 201 for
  // a new file, 200 for a replacement. The type comes from the file's name. Readers see the change at once.
  route("PUT", "/api/admin/sources/:alias/files/*", async (request, _url, params) => {
    const alias = params.alias ?? "";
    const path = filePath(params["*"] ?? "");
    const session = await enter(request, "admin", () => [fileTargetQuery(alias, path)]);
    const target = session.rows[0]?.[0];
    if (!target) throw new HttpError(404, "Source not found.");
    // Said before a single byte is read, when the request tells its size.
    const tooLarge = new HttpError(413, `The file is too large: the maximum is ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
    if (Number(request.headers.get("content-length") ?? "0") > MAX_FILE_BYTES) throw tooLarge;
    const saved = await putFile(ctx, session.actor, alias, target, path, await request.arrayBuffer());
    return Response.json(saved.file, { status: saved.created ? 201 : 200, headers: NO_STORE });
  });

  route("DELETE", "/api/admin/sources/:alias/files/*", async (request, _url, params) => {
    const alias = params.alias ?? "";
    const path = filePath(params["*"] ?? "");
    const session = await enter(request, "admin", () => [fileTargetQuery(alias, path)]);
    await deleteFile(ctx, session.actor, alias, session.rows[0]?.[0], path);
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

    // Optional fields. Administrators: username and, only on one's own account, password. Readers:
    // username, email, sources (the complete list of granted aliases); never a password.
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

    // A suspended account keeps what it has and can do nothing with it, until it is reactivated.
    for (const [action, suspended] of [["suspend", true], ["reactivate", false]] as const) {
      route("POST", `${base}/:id/${action}`, async (request, _url, params) => {
        const { actor } = await enter(request, "admin");
        await setSuspended(ctx, actor, role, params.id ?? "", suspended);
        return { ok: true };
      });
    }
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

  // The same listing as a CSV file, for a spreadsheet or an outside auditor: up to 5000 entries, with the same
  // filters. When there are more, the `x-gatefold-next-before` header says what to send as `before` for the next
  // part. Exporting is itself written to the log.
  route("GET", "/api/admin/audit.csv", async (request, url) => {
    const { actor } = await enter(request, "admin");
    const [rows = []] = await ctx.db.batch(exportAuditQueries(actor, url.searchParams));
    const file = auditCsv(rows);
    return new Response(file.text, {
      headers: {
        ...NO_STORE,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
        ...(file.next_before === null ? {} : { "x-gatefold-next-before": String(file.next_before) }),
      },
    });
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
  route("GET", "/api/reader/invite/:token", async (request, _url, params) => {
    const { username, expires_at } = await findInvite(ctx, request, params.token ?? "");
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

  // The policy: what an administrator must not be able to change about how they are watched.
  // `audit_retention_days`: audit entries older than this are removed (90 to 3650).
  route("GET", "/api/root/settings", async (request) => {
    await requireRoot(ctx, request);
    return policy(await ctx.db.query(...POLICY));
  });

  route("PUT", "/api/root/settings", async (request) => {
    await requireRoot(ctx, request);
    return setPolicy(ctx, rootActor(ipOf(ctx, request)), await body(request));
  });

  // The way back in when no administrator can sign in: a new password (`{ "password": "..." }`), or a suspension lifted.
  route("PUT", "/api/root/admins/:id", async (request, _url, params) => {
    await requireRoot(ctx, request);
    await updateAccount(ctx, rootActor(ipOf(ctx, request)), "admin", params.id ?? "", { password: (await body(request)).password });
    return { ok: true };
  });

  // For an administrator who lost their phone: their two-step verification is turned off, and they sign in with the password alone.
  route("DELETE", "/api/root/admins/:id/two-step", async (request, _url, params) => {
    await requireRoot(ctx, request);
    await resetTwoStep(ctx, rootActor(ipOf(ctx, request)), params.id ?? "");
    return { ok: true };
  });

  route("POST", "/api/root/admins/:id/reactivate", async (request, _url, params) => {
    await requireRoot(ctx, request);
    await setSuspended(ctx, rootActor(ipOf(ctx, request)), "admin", params.id ?? "", false);
    return { ok: true };
  });

  route("DELETE", "/api/root/admins/:id", async (request, _url, params) => {
    await requireRoot(ctx, request);
    await deleteAccount(ctx, rootActor(ipOf(ctx, request)), "admin", params.id ?? "");
    return { ok: true };
  });
}
