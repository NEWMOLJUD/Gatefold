// White-label: the name, logo and colours of an installation live in
// sites/label/, never in the code. This module reads that folder and serves
// its files at /label/.
//
//   sites/label/label.json   name, tagline, logo, favicon, footer
//   sites/label/style.css    colour palette and any other CSS override
//   sites/label/*.svg|png    the logo and favicon named in label.json
import type { Sites } from "../deps/sites.ts";
import { RESERVED_ALIAS } from "./core.ts";

export interface Label {
  /** Product name: page titles, sidebar and sign-in page. */
  name: string;
  /** One sentence shown beside the sign-in form. */
  tagline: string;
  /** File in sites/label/ shown on the brand colour, or `null` for the name's initial. */
  logo: string | null;
  favicon: string | null;
  /** Small print at the bottom of the reader pages and of the sign-in page. */
  footer: string;
}

/** What a page looks like when sites/label/ is missing or label.json is broken. */
export const DEFAULT_LABEL: Label = { name: "Canone", tagline: "Private sites, delivered to the right readers.", logo: null, favicon: null, footer: "" };

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Only what a brand needs is public: images, fonts and stylesheets. */
const PUBLIC_EXTENSIONS = new Set(["css", "svg", "png", "jpg", "jpeg", "webp", "avif", "gif", "ico", "woff", "woff2"]);

function words(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : fallback;
}

function fileName(value: unknown): string | null {
  return typeof value === "string" && FILE_NAME.test(value) && PUBLIC_EXTENSIONS.has(extension(value)) ? value : null;
}

function extension(path: string): string {
  return path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
}

/** Reads sites/label/label.json. A missing or invalid file falls back to the defaults, key by key. */
export async function loadLabel(sites: Sites): Promise<Label> {
  const file = await sites.get(`${RESERVED_ALIAS}/label.json`);
  if (!file) return DEFAULT_LABEL;
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    console.warn("sites/label/label.json is not valid JSON: using the default label.");
    return DEFAULT_LABEL;
  }
  if (parsed === null || typeof parsed !== "object") return DEFAULT_LABEL;
  const config = parsed as Record<string, unknown>;
  return {
    name: words(config.name, DEFAULT_LABEL.name, 60),
    tagline: words(config.tagline, "", 200),
    logo: fileName(config.logo),
    favicon: fileName(config.favicon),
    footer: words(config.footer, "", 200),
  };
}

/** `GET /label/<file>`: public, because the sign-in page needs the logo and the colours. */
export async function labelFile(sites: Sites, request: Request, path: string): Promise<Response> {
  const file = PUBLIC_EXTENSIONS.has(extension(path)) ? await sites.get(`${RESERVED_ALIAS}/${path}`) : null;
  if (!file) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const headers = new Headers({
    "content-type": file.headers.get("content-type") ?? "application/octet-stream",
    // Always revalidated: a new logo shows up right after the next publish.
    "cache-control": "public, no-cache",
    "x-content-type-options": "nosniff",
    // An SVG opened on its own must not run scripts.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  const etag = file.headers.get("etag");
  if (etag) {
    headers.set("etag", etag);
    if (request.headers.get("if-none-match") === etag) {
      await file.body?.cancel();
      return new Response(null, { status: 304, headers });
    }
  }
  return new Response(file.body, { headers });
}
