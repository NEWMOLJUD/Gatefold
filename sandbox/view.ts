// Serving the sources' files: permission, reading the file storage, merging
// the props and rendering. A single database round trip per file, which also
// says whether the file exists; the rendering settings come from the source's
// source.json.
import { ALIAS, type Ctx, HttpError, PLATFORM_PROPS, Reply, type Statement, type UserRef, fileKey, identify, platformProps, redirect, sourceAccessRows, sourceSettings } from "./core.ts";
import { extensionOf } from "./mime.ts";
import { SOURCE_CONFIG } from "./source-config.ts";
import { TemplateError, render } from "./template.ts";

/** Files larger than this are served as they are, without going through the engine. */
const MAX_RENDER_BYTES = 1024 * 1024;

/** Never rendered, even if the extension is in the source's list. */
const BINARY = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "pdf", "zip", "gz", "br", "tar", "rar", "7z",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "m4a", "m4v", "mov", "avi", "mkv", "webm", "ogg", "ogv", "wav", "flac",
  "wasm", "bin", "exe", "dll", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "epub",
]);

/** Headers that carry credentials: they never reach the template. */
const HIDDEN_HEADERS = /^(cookie|authorization|proxy-authorization|x-root-password|x-api-key|cf-access-.*)$/;

function sourceQuery(alias: string, user: UserRef | null): Statement {
  const allowed = user ? `EXISTS (SELECT 1 FROM permissions p WHERE p.source_alias = s.alias AND p.reader_id = ${user.sql})` : "0";
  return [`SELECT s.public, s.props, s.render, s.storage, ${allowed} AS allowed FROM sources s WHERE s.alias = ?`, ...(user?.params ?? []), alias];
}

/** Which of these exist: the file asked for, the index.html of a folder with its name, and the source's settings. */
function filesQuery(alias: string, path: string): Statement {
  return ["SELECT path FROM source_files WHERE alias = ? AND path IN (?, ?, ?)", alias, path, `${path}/index.html`, SOURCE_CONFIG];
}

/**
 * `mode` "page" serves `/reader/view/...` (cookie; without a session the
 * visitor goes to the login). "api" serves `/api/reader/view/...` (cookie or
 * key; never redirects).
 */
export async function view(ctx: Ctx, request: Request, alias: string, rest: string, mode: "page" | "api"): Promise<Response> {
  const url = new URL(request.url);
  const path = rest === "" || url.pathname.endsWith("/") ? `${rest === "" ? "" : `${rest}/`}index.html` : rest;
  const { session, rows } = await identify(ctx, request, "reader", {
    allowKey: mode === "api",
    // The last two write down that a reader opened a private source, or was refused one: once an hour each.
    reads: (user) => {
      const access = sourceAccessRows(ctx, request, alias, user);
      return [sourceQuery(alias, user), PLATFORM_PROPS, filesQuery(alias, path), access.read, access.denied];
    },
    visitorReads: [sourceQuery(alias, null), PLATFORM_PROPS, filesQuery(alias, path)],
  });
  if (mode === "api" && !session) throw new HttpError(401, "Not authenticated.");

  // A nonexistent alias and a private alias get the same answer, so aliases are not revealed.
  const source = ALIAS.test(alias) ? rows[0]?.[0] : undefined;
  if (!source || (source.public !== 1 && !(session && source.allowed === 1))) {
    if (session) throw new HttpError(403, "You do not have access to this source.");
    throw new Reply(redirect(`/reader/?next=${encodeURIComponent(url.pathname + url.search)}`));
  }

  // Without the trailing slash the page's relative links would point to the wrong place.
  if (rest === "" && !url.pathname.endsWith("/")) throw new Reply(redirect(`${url.pathname}/${url.search}`));
  if (path.includes("\\") || path.split("/").some((segment) => segment === "" || segment.startsWith("."))) {
    throw new HttpError(400, "Address refused.");
  }

  // The source's settings are for the system, not for readers.
  if (path === SOURCE_CONFIG) throw new HttpError(404, "File not found.");

  // A file exists when it has a row: the storage is only asked for what the database says is there.
  const present = new Set((rows[2] ?? []).map((row) => String(row.path)));
  if (!present.has(path)) {
    // A folder requested without the trailing slash: redirect to the right address, if it has an index.html.
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name.includes(".") && present.has(`${path}/index.html`)) throw new Reply(redirect(`${url.pathname}/${url.search}`));
    throw new HttpError(404, "File not found.");
  }

  // Only a file that could be rendered needs the settings: images and the like skip that read.
  const extension = extensionOf(path);
  const [file, settings] = await Promise.all([
    ctx.files.get(fileKey(String(source.storage), path)),
    BINARY.has(extension) ? null : sourceSettings(ctx, source, present.has(SOURCE_CONFIG)),
  ]);
  if (!file) throw new HttpError(404, "File not found.");

  const isPublic = source.public === 1;
  const headers = new Headers({
    "content-type": file.headers.get("content-type") ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
    // A source's pages are the installation's own content: what they load and run is their business.
    // What is decided here is who may put them in a frame: this site (the reader's "Open in frame"), and nobody else.
    "content-security-policy": "frame-ancestors 'self'",
    "x-frame-options": "SAMEORIGIN",
  });
  let renderable = settings !== null && settings.render.includes(extension);
  let bytes: ArrayBuffer | null = null;
  let text = "";
  if (renderable) {
    bytes = await file.arrayBuffer();
    try {
      if (bytes.byteLength > MAX_RENDER_BYTES) throw new RangeError("too large");
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      renderable = false; // not text (or too large): served as it is
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
  // platform < source < reader: the most specific wins.
  const props = { ...platformProps(rows[1]), ...(settings?.props ?? {}), ...(session?.user.props ?? {}) };

  let body: string;
  try {
    body = render(text, { props, query, headers: requestHeaders });
  } catch (error) {
    if (!(error instanceof TemplateError)) throw error;
    // What is wrong goes to the log, for whoever maintains the source; the reader is not shown the inside of it.
    console.error(`Template error in the source ${alias}, file ${path}: ${error.message}`);
    throw new HttpError(500, "This page could not be rendered. Tell whoever publishes it: the reason is in the server log.");
  }
  // The result depends on the reader, the query and the headers: it is never cached.
  headers.set("cache-control", "private, no-store");
  return new Response(body, { headers });
}
