// HTML of the system pages. Everything that goes into a page passes through
// `html`, which escapes the values: no data from the database becomes markup.
import type { Label } from "./label.ts";
import type { Role } from "./security.ts";
import { APP_CSS, APP_JS, fingerprint } from "./styles.ts";
import { escapeHtml } from "./template.ts";

/** A piece of HTML that is already safe. */
export class Safe {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

type Value = string | number | boolean | null | undefined | Safe | Value[];

function show(value: Value): string {
  if (value === null || value === undefined || value === false || value === true) return "";
  if (value instanceof Safe) return value.text;
  if (Array.isArray(value)) return value.map(show).join("");
  return escapeHtml(String(value));
}

/** Builds HTML, escaping every interpolated value. */
export function html(strings: TemplateStringsArray, ...values: Value[]): Safe {
  let text = strings[0]!;
  values.forEach((value, index) => (text += show(value) + strings[index + 1]!));
  return new Safe(text);
}

/** Addresses of the built-in stylesheet and script. The `?v=` changes whenever the content does. */
export const CSS_PATH = "/assets/app.css";
export const JS_PATH = "/assets/app.js";
const CSS_HREF = `${CSS_PATH}?v=${fingerprint(APP_CSS)}`;
const JS_HREF = `${JS_PATH}?v=${fingerprint(APP_JS)}`;

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const ICONS = {
  home: "M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  users: "M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 20v-1a4 4 0 0 0-3-3.85M15.5 4.2a3.5 3.5 0 0 1 0 6.6",
  shield: "M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 4v4M10 10v4M18 16v4",
  key: "M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 12l9-9M16 7l3 3",
  logout: "M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 16l4-4-4-4M20 12H9",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14M13 6l6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 9v4M12 16.5v.5M10.3 3.9L2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5v.5",
  book: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11",
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): Safe {
  return new Safe(`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export type Tone = "ok" | "danger" | "warn" | "info";

const TONE_ICON: Record<Tone, IconName> = { ok: "check", danger: "alert", warn: "alert", info: "info" };

export function alert(tone: Tone, body: Safe | string): Safe {
  return html`<div class="alert alert-${tone}" role="${tone === "danger" ? "alert" : "status"}">${icon(TONE_ICON[tone])}<div>${body}</div></div>`;
}

export function badge(text: string, tone: "ok" | "warn" | "danger" | "muted" = "muted"): Safe {
  return html`<span class="badge badge-${tone}">${text}</span>`;
}

export interface CardOptions {
  title?: string;
  description?: Safe | string;
  /** Buttons at the bottom, right-aligned on a tinted strip. */
  footer?: Safe;
  /** Extra classes: "narrow", "danger-zone". */
  class?: string;
  /** No padding around the body: tables and link lists go edge to edge. */
  flush?: boolean;
}

export function card(body: Safe, options: CardOptions = {}): Safe {
  return html`<section class="card ${options.class ?? ""}">
${options.title ? html`<div class="card-head"><h2>${options.title}</h2>${options.description ? html`<p>${options.description}</p>` : ""}</div>` : ""}
${options.flush ? body : html`<div class="card-body">${body}</div>`}
${options.footer ? html`<div class="card-foot">${options.footer}</div>` : ""}</section>`;
}

export function empty(symbol: IconName, title: string, text: Safe | string, action?: Safe): Safe {
  return html`<div class="empty">${icon(symbol)}<h3>${title}</h3><p>${text}</p>${action ?? ""}</div>`;
}

/** A labelled form control. `control` must carry `id="<id>"`. */
export function field(id: string, label: string, control: Safe, hint?: Safe | string): Safe {
  return html`<div class="field"><label for="${id}">${label}</label>${control}${hint ? html`<span class="hint">${hint}</span>` : ""}</div>`;
}

export function date(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 16).replace("T", " ");
}

/** "Previous" and "Next" links that keep the filters of the listing. */
export function pager(url: URL, current: number, hasNext: boolean): Safe {
  if (current === 1 && !hasNext) return new Safe("");
  const link = (target: number, label: string): Safe => {
    const params = new URLSearchParams(url.searchParams);
    params.delete("ok");
    params.delete("error");
    params.set("page", String(target));
    return html`<a class="btn btn-sm" href="${url.pathname}?${params.toString()}">${label}</a>`;
  };
  return html`<div class="pager"><span>Page ${current}</span><div>${current > 1 ? link(current - 1, "Previous") : ""}${hasNext ? link(current + 1, "Next") : ""}</div></div>`;
}

// ---------------------------------------------------------------------------
// Page shells
// ---------------------------------------------------------------------------

const NAV: Record<Role, [href: string, label: string, symbol: IconName][]> = {
  admin: [
    ["/admin/home", "Overview", "home"],
    ["/admin/list-sources", "Sources", "folder"],
    ["/admin/list-readers", "Readers", "users"],
    ["/admin/list-admins", "Administrators", "shield"],
    ["/admin/config", "Platform props", "sliders"],
    ["/admin/api-keys", "API keys", "key"],
  ],
  reader: [
    ["/reader/home", "Library", "book"],
    ["/reader/config", "Preferences", "sliders"],
    ["/reader/api-keys", "API keys", "key"],
  ],
};

export interface PageOptions {
  title: string;
  body: Safe;
  /** One line under the title. */
  subtitle?: Safe | string;
  /** Who is signed in: picks the administrator or the reader shell. */
  role?: Role;
  username?: string;
  /** Menu entry to highlight (its address). */
  active?: string;
  /** Path back to the listing: `[label, address]` pairs shown above the title. */
  crumbs?: [label: string, href: string][];
  /** Buttons at the right of the title. */
  actions?: Safe;
  /** Requested address, to show the `?ok=` and `?error=` messages. */
  url?: URL;
  status?: number;
  /** Without a role: "wide" gives the box room for a table (only /root/setup uses it). */
  wide?: boolean;
  /** Extra scripts (only /root/setup uses it). */
  scripts?: string[];
}

function brand(label: Label, href: string): Safe {
  return html`<a class="brand" href="${href}">${label.logo
    ? html`<img src="/label/${label.logo}" alt="${label.name}">`
    : html`<span class="brand-initial" aria-hidden="true">${label.name.slice(0, 1).toUpperCase()}</span><span>${label.name}</span>`}</a>`;
}

function flashes(url: URL | undefined): Safe {
  const ok = url?.searchParams.get("ok");
  const error = url?.searchParams.get("error");
  return html`${ok ? alert("ok", ok) : ""}${error ? alert("danger", error) : ""}`;
}

function menu(role: Role, active: string | undefined): Safe {
  return html`<nav class="nav" aria-label="Main">${NAV[role].map(([href, label, symbol]) =>
    html`<a href="${href}" ${href === active ? new Safe('aria-current="page"') : ""}>${icon(symbol)}<span>${label}</span></a>`)}</nav>`;
}

function signOut(role: Role): Safe {
  return html`<form method="post" action="/${role}/logout"><button class="icon-btn" title="Sign out" aria-label="Sign out">${icon("logout")}</button></form>`;
}

function heading(options: PageOptions): Safe {
  return html`<div class="head"><div>
${options.crumbs ? html`<nav class="crumbs" aria-label="Breadcrumb">${options.crumbs.map(([label, href], index) =>
    index === 0 ? html`<a href="${href}">${label}</a>` : html`<span><a href="${href}">${label}</a></span>`)}<span>${options.title}</span></nav>` : ""}
<h1>${options.title}</h1>${options.subtitle ? html`<p class="sub">${options.subtitle}</p>` : ""}</div>
${options.actions ? html`<div class="actions">${options.actions}</div>` : ""}</div>`;
}

function adminShell(label: Label, options: PageOptions): Safe {
  const username = options.username ?? "";
  return html`<div class="shell"><aside class="side">${brand(label, "/admin/home")}
<div class="side-label">Administration</div>${menu("admin", options.active)}
<div class="side-user"><span class="avatar" aria-hidden="true">${username.slice(0, 1)}</span>
<div class="who"><strong>${username}</strong><span>Administrator</span></div>${signOut("admin")}</div></aside>
<main class="content">${heading(options)}${flashes(options.url)}${options.body}</main></div>`;
}

function readerShell(label: Label, options: PageOptions): Safe {
  return html`<header class="top"><div class="top-in">${brand(label, "/reader/home")}${menu("reader", options.active)}
<div class="top-user"><span class="name">${options.username}</span>${signOut("reader")}</div></div></header>
<main class="reader">${heading(options)}${flashes(options.url)}${options.body}</main>
${label.footer ? html`<footer class="foot">${label.footer}</footer>` : ""}`;
}

/** Sign-in, root setup and message pages: the brand on one side, a box on the other. */
function publicShell(label: Label, options: PageOptions): Safe {
  return html`<div class="auth"><aside class="auth-brand">${brand(label, "/")}
${label.tagline ? html`<blockquote>${label.tagline}</blockquote>` : ""}<small>${label.footer}</small></aside>
<main class="auth-main"><div class="auth-box ${options.wide ? "wide" : ""}">
${options.status && options.status >= 400 ? html`<p class="status">Error ${options.status}</p>` : ""}
<h1>${options.title}</h1><p class="sub">${options.subtitle ?? ""}</p>${flashes(options.url)}${options.body}</div></main></div>`;
}

export function page(label: Label, options: PageOptions): Response {
  const shell = options.role === "admin" ? adminShell(label, options) : options.role === "reader" ? readerShell(label, options) : publicShell(label, options);
  const document = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${options.title} · ${label.name}</title>
${label.favicon ? html`<link rel="icon" href="/label/${label.favicon}">` : ""}
<link rel="stylesheet" href="${CSS_HREF}"><link rel="stylesheet" href="/label/style.css"></head>
<body>${shell}<script src="${JS_HREF}" defer></script>${(options.scripts ?? []).map((src) => html`<script src="${src}" defer></script>`)}</body></html>`;
  return new Response(document.text, {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; script-src 'self'; connect-src 'self'; " +
        "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
}

const ASSET_HEADERS = { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" };

/** The built-in stylesheet and script. Cached for good: their address carries a fingerprint. */
export function asset(path: string): Response {
  return path === CSS_PATH
    ? new Response(APP_CSS, { headers: { ...ASSET_HEADERS, "content-type": "text/css; charset=utf-8" } })
    : new Response(APP_JS, { headers: { ...ASSET_HEADERS, "content-type": "text/javascript; charset=utf-8" } });
}
