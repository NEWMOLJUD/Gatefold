// HTML das páginas do sistema. Tudo o que entra em uma página passa por
// `html`, que escapa os valores: nenhum dado do banco vira marcação.
import type { Role } from "./security.ts";
import { escapeHtml } from "./template.ts";

/** Trecho de HTML já seguro. */
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

/** Monta HTML escapando cada valor interpolado. */
export function html(strings: TemplateStringsArray, ...values: Value[]): Safe {
  let text = strings[0]!;
  values.forEach((value, index) => (text += show(value) + strings[index + 1]!));
  return new Safe(text);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--soft:#5f6168;--line:#dcdad4;--accent:#1f5fbf;--bad:#b3261e;--good:#1b6e3c;--warn:#8a5a00}
@media(prefers-color-scheme:dark){:root{--bg:#141517;--card:#1e2023;--ink:#ececec;--soft:#a3a6ad;--line:#33363b;--accent:#7fb0ff;--bad:#ff8a80;--good:#7ddc9c;--warn:#f0c060}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header strong{font-size:18px}header nav{display:flex;flex-wrap:wrap;gap:4px 14px;flex:1}header form{margin:0}
main{max-width:920px;margin:0 auto;padding:20px 16px 48px}h1{font-size:24px;margin:0 0 16px}h2{font-size:18px;margin:28px 0 8px}
a{color:var(--accent)}label{display:block;margin:14px 0 4px;font-weight:600}small,.soft{color:var(--soft);font-weight:400}
input[type=text],input[type=password],input[type=date],input[type=number],select,textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit}
textarea{min-height:180px;font-family:ui-monospace,monospace;font-size:14px}
button{padding:8px 16px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:var(--card);font:inherit;cursor:pointer}
button.plain{background:none;color:var(--accent)}button.danger{background:none;border-color:var(--bad);color:var(--bad)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-top:16px}.row>div{flex:1;min-width:150px}.row label{margin-top:0}
.check{display:flex;gap:8px;align-items:center;font-weight:400;margin:8px 0}.check input{width:18px;height:18px}
.note{padding:10px 12px;border-radius:6px;border:1px solid var(--line);margin:12px 0;background:var(--card)}
.note.ok{border-color:var(--good);color:var(--good)}.note.bad{border-color:var(--bad);color:var(--bad)}.note.warn{border-color:var(--warn);color:var(--warn)}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;padding:0;list-style:none}
.cards a{display:block;padding:16px;border:1px solid var(--line);border-radius:8px;background:var(--card);text-decoration:none}
code{font-family:ui-monospace,monospace;word-break:break-all}.narrow{max-width:420px}dialog{border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);width:min(92vw,380px)}
`;

const NAV: Record<Role, [string, string][]> = {
  admin: [
    ["/admin/home", "Início"], ["/admin/list-sources", "Fontes"], ["/admin/list-readers", "Leitores"],
    ["/admin/list-admins", "Administradores"], ["/admin/config", "Props"], ["/admin/api-keys", "Chaves de API"],
  ],
  reader: [["/reader/home", "Início"], ["/reader/config", "Meus props"], ["/reader/api-keys", "Chaves de API"]],
};

export interface PageOptions {
  title: string;
  body: Safe;
  /** Quem está logado: mostra o menu e o botão "Sair". */
  role?: Role;
  username?: string;
  /** Endereço pedido, para mostrar as mensagens `?ok=` e `?erro=`. */
  url?: URL;
  status?: number;
  /** A página carrega este script (só `/root/setup` usa). */
  script?: string;
}

export function page(options: PageOptions): Response {
  const ok = options.url?.searchParams.get("ok");
  const error = options.url?.searchParams.get("erro");
  const header = options.role
    ? html`<header><strong>Canone</strong><nav>${NAV[options.role].map(([href, label]) => html`<a href="${href}">${label}</a>`)}</nav>
<span class="soft">${options.username}</span><form method="post" action="/${options.role}/logout"><button class="plain">Sair</button></form></header>`
    : html`<header><strong>Canone</strong></header>`;
  const document = html`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${options.title} · Canone</title><style>${new Safe(STYLE)}</style></head>
<body>${header}<main><h1>${options.title}</h1>
${ok ? html`<p class="note ok">${ok}</p>` : ""}${error ? html`<p class="note bad">${error}</p>` : ""}
${options.body}</main>${options.script ? html`<script src="${options.script}"></script>` : ""}</body></html>`;
  return new Response(document.text, {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` +
        (options.script ? "; script-src 'self'; connect-src 'self'" : ""),
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
}

export function date(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 16).replace("T", " ");
}

/** Links "anterior" e "próxima" que mantêm os filtros da listagem. */
export function pager(url: URL, current: number, hasNext: boolean): Safe {
  const link = (target: number, label: string): Safe => {
    const params = new URLSearchParams(url.searchParams);
    params.delete("ok");
    params.delete("erro");
    params.set("page", String(target));
    return html`<a href="${url.pathname}?${params.toString()}">${label}</a>`;
  };
  return html`<p class="soft">Página ${current} ${current > 1 ? link(current - 1, "← anterior") : ""} ${hasNext ? link(current + 1, "próxima →") : ""}</p>`;
}
