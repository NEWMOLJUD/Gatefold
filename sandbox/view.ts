// Entrega dos arquivos das fontes (seed.md, seção 6): permissão, leitura da
// pasta, merge dos props e renderização. Uma única ida ao banco por arquivo.
import { ALIAS, type Ctx, HttpError, PLATFORM_PROPS, Reply, type Statement, type UserRef, identify, platformProps, redirect } from "./core.ts";
import { TemplateError, render } from "./template.ts";

/** Arquivos acima disto são entregues como estão, sem passar pela engine. */
const MAX_RENDER_BYTES = 1024 * 1024;

/** Nunca renderizados, mesmo que a extensão esteja na lista da fonte. */
const BINARY = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "pdf", "zip", "gz", "br", "tar", "rar", "7z",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "m4a", "m4v", "mov", "avi", "mkv", "webm", "ogg", "ogv", "wav", "flac",
  "wasm", "bin", "exe", "dll", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "epub",
]);

/** Cabeçalhos que carregam credenciais: nunca chegam ao template (seção 12, item 2). */
const HIDDEN_HEADERS = /^(cookie|authorization|proxy-authorization|x-root-password|x-api-key|cf-access-.*)$/;

function sourceQuery(alias: string, user: UserRef | null): Statement {
  const allowed = user ? `EXISTS (SELECT 1 FROM permissions p WHERE p.source_alias = s.alias AND p.reader_id = ${user.sql})` : "0";
  return [`SELECT s.public, s.props, s.render, ${allowed} AS allowed FROM sources s WHERE s.alias = ?`, ...(user?.params ?? []), alias];
}

function object(text: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(text));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * `mode` "page" atende `/reader/view/...` (cookie; quem não tem sessão vai ao
 * login). "api" atende `/api/reader/view/...` (cookie ou chave; nunca redireciona).
 */
export async function view(ctx: Ctx, request: Request, alias: string, rest: string, mode: "page" | "api"): Promise<Response> {
  const url = new URL(request.url);
  const { session, rows } = await identify(ctx, request, "reader", {
    allowKey: mode === "api",
    reads: (user) => [sourceQuery(alias, user), PLATFORM_PROPS],
    visitorReads: [sourceQuery(alias, null), PLATFORM_PROPS],
  });
  if (mode === "api" && !session) throw new HttpError(401, "Não autenticado.");

  // Alias inexistente e alias privado têm a mesma resposta (seção 12, item 11).
  const source = ALIAS.test(alias) ? rows[0]?.[0] : undefined;
  if (!source || (source.public !== 1 && !(session && source.allowed === 1))) {
    if (session) throw new HttpError(403, "Você não tem acesso a esta fonte.");
    throw new Reply(redirect(`/reader/?next=${encodeURIComponent(url.pathname + url.search)}`));
  }

  // Sem a barra final os links relativos da página apontariam para o lugar errado.
  if (rest === "" && !url.pathname.endsWith("/")) throw new Reply(redirect(`${url.pathname}/${url.search}`));
  const path = rest === "" || url.pathname.endsWith("/") ? `${rest === "" ? "" : `${rest}/`}index.html` : rest;
  if (path.includes("\\") || path.split("/").some((segment) => segment === "" || segment.startsWith("."))) {
    throw new HttpError(400, "Endereço recusado.");
  }

  const file = await ctx.sites.get(`${alias}/${path}`);
  if (!file) {
    // Uma pasta pedida sem a barra final: leva ao endereço certo, se houver um index.html nela.
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name.includes(".") && (await ctx.sites.get(`${alias}/${path}/index.html`))) throw new Reply(redirect(`${url.pathname}/${url.search}`));
    throw new HttpError(404, "Arquivo não encontrado.");
  }

  const isPublic = source.public === 1;
  const headers = new Headers({
    "content-type": file.headers.get("content-type") ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  let renderable = !BINARY.has(extension) && (JSON.parse(String(source.render)) as unknown[]).includes(extension);
  let bytes: ArrayBuffer | null = null;
  let text = "";
  if (renderable) {
    bytes = await file.arrayBuffer();
    try {
      if (bytes.byteLength > MAX_RENDER_BYTES) throw new RangeError("grande demais");
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      renderable = false; // não é texto (ou é grande demais): segue como está
    }
  }

  if (!renderable) {
    const etag = file.headers.get("etag");
    headers.set("cache-control", isPublic ? "public, no-cache" : "private, no-cache");
    if (etag) {
      headers.set("etag", etag);
      if (request.headers.get("if-none-match") === etag) {
        if (!bytes) await file.body?.cancel();
        return new Response(null, { status: 304, headers });
      }
    }
    return new Response(bytes ?? file.body, { headers });
  }

  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) query[name] = value;
  const requestHeaders: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!HIDDEN_HEADERS.test(name.toLowerCase())) requestHeaders[name.toLowerCase()] = value;
  });
  // plataforma < fonte < leitor: o mais específico vence (seção 5).
  const props = { ...platformProps(rows[1]), ...object(source.props), ...(session?.user.props ?? {}) };

  let body: string;
  try {
    body = render(text, { props, query, headers: requestHeaders });
  } catch (error) {
    if (!(error instanceof TemplateError)) throw error;
    throw new HttpError(500, `Erro no template ${path}: ${error.message}`);
  }
  // O resultado depende do leitor, da query e dos cabeçalhos: nunca fica em cache.
  headers.set("cache-control", "private, no-store");
  return new Response(body, { headers });
}
