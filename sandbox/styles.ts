// The built-in stylesheet and script of the system pages, served from
// /assets/. Colours, radius and fonts are CSS variables: an installation
// changes them in sites/label/style.css, which every page loads after this
// file, and never needs to edit this one.

export const APP_CSS = `
:root {
  color-scheme: light dark;
  /* Brand: overridden by sites/label/style.css */
  --brand: #2f5bea;
  --brand-contrast: #ffffff;
  --brand-surface: #0f1a33;
  --brand-surface-ink: #ffffff;
  /* Neutrals */
  --bg: #f4f6fa;
  --surface: #ffffff;
  --surface-2: #f8f9fc;
  --ink: #111827;
  --muted: #5b6474;
  --line: #e2e6ee;
  /* Status */
  --ok: #0f7a55;
  --ok-bg: #e6f6ef;
  --danger: #c0272d;
  --danger-bg: #fdeced;
  --warn: #8a5a00;
  --warn-bg: #fff4d6;
  /* Shape and type */
  --radius: 10px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --shadow: 0 1px 2px rgba(16, 24, 40, .05), 0 1px 3px rgba(16, 24, 40, .07);
}
@media (prefers-color-scheme: dark) {
  :root {
    --brand: #7c9bff;
    --brand-contrast: #0b1020;
    --brand-surface: #0a1122;
    --bg: #0d121c;
    --surface: #161d2b;
    --surface-2: #1b2334;
    --ink: #e8ecf4;
    --muted: #9aa6ba;
    --line: #283246;
    --ok: #5fd3a4;
    --ok-bg: #12382c;
    --danger: #ff8f8f;
    --danger-bg: #43191c;
    --warn: #f2c66d;
    --warn-bg: #3d2f0d;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4);
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 var(--font); }
h1, h2, h3, p { margin: 0; }
a { color: var(--brand); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: var(--mono); font-size: .92em; word-break: break-all; }
.icon { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.muted { color: var(--muted); }
.stack > * + * { margin-top: 16px; }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

/* ---- Brand mark ---------------------------------------------------- */
.brand { display: flex; align-items: center; gap: 10px; color: var(--brand-surface-ink); font-weight: 650; font-size: 17px; letter-spacing: -.01em; }
.brand:hover { text-decoration: none; }
.brand img { height: 30px; width: auto; max-width: 150px; display: block; }
.brand-initial { width: 30px; height: 30px; border-radius: 8px; background: var(--brand); color: var(--brand-contrast); display: grid; place-items: center; font-weight: 700; }

/* ---- Administrator shell: sidebar + content ------------------------ */
.shell { display: grid; grid-template-columns: 252px minmax(0, 1fr); min-height: 100vh; }
.side { background: var(--brand-surface); color: var(--brand-surface-ink); display: flex; flex-direction: column; padding: 20px 14px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.side .brand { padding: 4px 8px 20px; }
.side-label { padding: 14px 10px 6px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: color-mix(in srgb, var(--brand-surface-ink) 50%, transparent); }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav a { display: flex; align-items: center; gap: 10px; white-space: nowrap; padding: 9px 10px; border-radius: 8px; color: color-mix(in srgb, var(--brand-surface-ink) 74%, transparent); font-weight: 500; }
.nav a:hover { background: color-mix(in srgb, var(--brand-surface-ink) 8%, transparent); color: var(--brand-surface-ink); text-decoration: none; }
.nav a[aria-current] { background: color-mix(in srgb, var(--brand-surface-ink) 14%, transparent); color: var(--brand-surface-ink); }
.side-user { margin-top: auto; padding: 14px 8px 0; border-top: 1px solid color-mix(in srgb, var(--brand-surface-ink) 14%, transparent); display: flex; align-items: center; gap: 10px; }
.avatar { width: 32px; height: 32px; border-radius: 50%; background: color-mix(in srgb, var(--brand-surface-ink) 16%, transparent); display: grid; place-items: center; font-weight: 600; text-transform: uppercase; flex: none; }
.who { min-width: 0; flex: 1; line-height: 1.3; }
.who strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.who span { font-size: 12px; color: color-mix(in srgb, var(--brand-surface-ink) 60%, transparent); }
.side-user form { margin: 0; }
.icon-btn { display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 8px; background: none; color: inherit; cursor: pointer; opacity: .75; }
.icon-btn:hover { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
.content { padding: 32px 36px 64px; max-width: 1180px; width: 100%; }

/* ---- Reader shell: top bar + content ------------------------------- */
.top { background: var(--brand-surface); color: var(--brand-surface-ink); }
.top-in { max-width: 1080px; margin: 0 auto; padding: 0 24px; min-height: 60px; display: flex; align-items: center; gap: 8px 28px; flex-wrap: wrap; }
.top .nav { flex-direction: row; flex: 1; gap: 4px; }
.top .nav a { padding: 7px 12px; }
.top-user { display: flex; align-items: center; gap: 10px; }
.top-user form { margin: 0; }
.top-user .name { font-weight: 500; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reader { max-width: 1080px; margin: 0 auto; padding: 36px 24px 64px; }
.foot { max-width: 1080px; margin: 0 auto; padding: 0 24px 32px; color: var(--muted); font-size: 13px; }

/* ---- Page head ------------------------------------------------------ */
.head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 12px 20px; margin-bottom: 24px; }
.head h1 { font-size: 24px; line-height: 1.25; letter-spacing: -.02em; font-weight: 680; }
.head .sub { color: var(--muted); margin-top: 4px; max-width: 70ch; }
.crumbs { display: flex; flex-wrap: wrap; gap: 6px; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
.crumbs a { color: var(--muted); }
.crumbs span::before { content: "/"; margin-right: 6px; opacity: .6; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }

/* ---- Cards ---------------------------------------------------------- */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 20px; }
.card-head { padding: 16px 20px; border-bottom: 1px solid var(--line); }
.card-head h2 { font-size: 15px; font-weight: 650; }
.card-head p { color: var(--muted); font-size: 13.5px; margin-top: 2px; }
.card-body { padding: 20px; }
.card-foot { padding: 14px 20px; border-top: 1px solid var(--line); background: var(--surface-2); border-radius: 0 0 var(--radius) var(--radius); display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }
.card.danger-zone { border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
.split { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px 20px; }
.split > div { flex: 1; min-width: 220px; }
.narrow { max-width: 640px; }

/* ---- Buttons -------------------------------------------------------- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; font-weight: 550; line-height: 1.4; cursor: pointer; white-space: nowrap; }
.btn:hover { background: var(--surface-2); text-decoration: none; }
.btn-primary { background: var(--brand); border-color: var(--brand); color: var(--brand-contrast); }
.btn-primary:hover { background: color-mix(in srgb, var(--brand) 88%, #000); }
.btn-danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
.btn-danger:hover { background: var(--danger-bg); }
.btn-sm { padding: 4px 10px; font-size: 13px; }
.btn-block { width: 100%; padding: 10px 14px; }

/* ---- Forms ---------------------------------------------------------- */
form { margin: 0; }
.field { display: block; }
.field + .field { margin-top: 16px; }
.field > label, .label { display: block; font-weight: 600; font-size: 13.5px; margin-bottom: 6px; }
.hint { display: block; color: var(--muted); font-size: 13px; margin-top: 6px; font-weight: 400; }
input[type=text], input[type=password], input[type=date], input[type=number], select, textarea {
  width: 100%; padding: 8px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; min-height: 38px;
}
input, select { height: 38px; }
.check input { height: 17px; }
input:focus, select:focus, textarea:focus { outline: 2px solid color-mix(in srgb, var(--brand) 55%, transparent); outline-offset: 0; border-color: var(--brand); }
textarea { min-height: 200px; font-family: var(--mono); font-size: 13.5px; line-height: 1.5; resize: vertical; }
.check { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; cursor: pointer; }
.check input { width: 17px; height: 17px; margin: 2px 0 0; accent-color: var(--brand); flex: none; }
.check input:disabled + span { color: var(--muted); }
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; align-items: end; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.filters .field + .field { margin-top: 0; }
.filters .btn { min-height: 38px; }

/* ---- Tables --------------------------------------------------------- */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); background: var(--surface-2); padding: 10px 20px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 13px 20px; border-bottom: 1px solid var(--line); white-space: nowrap; vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--surface-2); }
td.num, th.num { text-align: right; }
td.end { text-align: right; }
td strong a { color: var(--ink); }
.pager { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13.5px; }
.pager div { display: flex; gap: 8px; }

/* ---- Badges, alerts, empty states ---------------------------------- */
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge-ok { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.badge-warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.badge-danger { background: var(--danger-bg); color: var(--danger); border-color: transparent; }
.chip { display: inline-block; padding: 1px 7px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--line); font: 12px var(--mono); margin-right: 4px; }
.alert { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); margin-bottom: 20px; }
.alert .icon { margin-top: 2px; }
.alert p + p { margin-top: 6px; }
.alert-ok { background: var(--ok-bg); border-color: transparent; color: var(--ok); }
.alert-danger { background: var(--danger-bg); border-color: transparent; color: var(--danger); }
.alert-warn { background: var(--warn-bg); border-color: transparent; color: var(--warn); }
.alert[hidden] { display: none; }
.card-body > .alert:last-child, .field .alert { margin-bottom: 0; }
.field .alert { margin-top: 10px; font-size: 13.5px; }
.empty { text-align: center; padding: 48px 20px; color: var(--muted); }
.empty .icon { width: 34px; height: 34px; opacity: .55; margin-bottom: 10px; }
.empty h3 { color: var(--ink); font-size: 16px; margin-bottom: 4px; }
.empty .btn { margin-top: 16px; }
.secret { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 14px; border-radius: 8px; background: var(--surface-2); border: 1px dashed var(--line); margin: 12px 0; }
.secret code { flex: 1; min-width: 200px; font-size: 14px; }

/* ---- Dashboard ------------------------------------------------------ */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
.stat { display: block; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px; color: var(--ink); }
.stat:hover { border-color: var(--brand); text-decoration: none; }
.stat-top { display: flex; justify-content: space-between; align-items: center; color: var(--muted); font-size: 13.5px; font-weight: 550; }
.stat-top .icon { color: var(--brand); }
.stat b { display: block; font-size: 30px; line-height: 1.2; font-weight: 680; letter-spacing: -.02em; margin-top: 8px; }
.stat small { color: var(--muted); font-size: 13px; }
.links { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0; }
.links a { display: flex; gap: 12px; align-items: flex-start; padding: 16px 20px; color: var(--ink); border-top: 1px solid var(--line); }
.links a:hover { background: var(--surface-2); text-decoration: none; }
.links .icon { color: var(--brand); margin-top: 2px; }
.links span { display: block; color: var(--muted); font-size: 13.5px; }

/* ---- Reader home ---------------------------------------------------- */
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 18px; list-style: none; padding: 0; margin: 0 0 28px; }
.tile { display: flex; flex-direction: column; gap: 14px; height: 100%; padding: 20px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); color: var(--ink); transition: border-color .12s, transform .12s; }
.tile:hover { border-color: var(--brand); transform: translateY(-2px); text-decoration: none; }
.tile-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.tile-mark { width: 44px; height: 44px; border-radius: 10px; background: color-mix(in srgb, var(--brand) 14%, var(--surface)); color: var(--brand); display: grid; place-items: center; font-weight: 700; font-size: 18px; text-transform: uppercase; }
.tile h2 { font-size: 17px; font-weight: 650; letter-spacing: -.01em; word-break: break-word; }
.tile p { color: var(--muted); font-size: 13.5px; }
.tile-go { margin-top: auto; display: flex; align-items: center; gap: 6px; color: var(--brand); font-weight: 600; font-size: 14px; }

/* ---- Sign-in and message pages -------------------------------------- */
.auth { min-height: 100vh; display: grid; grid-template-columns: minmax(320px, 5fr) 7fr; }
.auth-brand { background: var(--brand-surface); color: var(--brand-surface-ink); padding: 48px; display: flex; flex-direction: column; justify-content: space-between; gap: 32px; }
.auth-brand .brand { font-size: 20px; }
.auth-brand .brand img { height: 40px; max-width: 220px; }
.auth-brand .brand-initial { width: 40px; height: 40px; font-size: 20px; }
.auth-brand blockquote { margin: 0; font-size: 26px; line-height: 1.3; letter-spacing: -.02em; font-weight: 600; max-width: 18ch; }
.auth-brand small { color: color-mix(in srgb, var(--brand-surface-ink) 60%, transparent); font-size: 13px; }
.auth-main { display: grid; place-items: center; padding: 40px 24px; }
.auth-box { width: 100%; max-width: 380px; }
.auth-box.wide { max-width: 620px; }
.auth-box h1 { font-size: 24px; letter-spacing: -.02em; font-weight: 680; }
.auth-box .sub { color: var(--muted); margin: 6px 0 24px; }
.auth-alt { margin-top: 24px; font-size: 13.5px; color: var(--muted); text-align: center; }
.status { font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--brand); margin-bottom: 8px; }
dialog { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); color: var(--ink); width: min(92vw, 400px); padding: 24px; box-shadow: 0 20px 50px rgba(0, 0, 0, .25); }
dialog::backdrop { background: rgba(10, 15, 30, .55); }

/* ---- Small screens -------------------------------------------------- */
@media (max-width: 900px) {
  .shell { display: block; }
  .side { position: static; height: auto; padding: 12px 14px; }
  .side .brand { padding: 4px 4px 10px; }
  .side-label { display: none; }
  .side .nav { flex-direction: row; overflow-x: auto; padding-bottom: 4px; }
  .side .nav a { white-space: nowrap; padding: 7px 10px; }
  .side-user { margin-top: 10px; padding-top: 10px; }
  .content { padding: 24px 16px 48px; }
  .auth { display: block; min-height: 0; }
  .auth-brand { padding: 24px; }
  .auth-brand blockquote, .auth-brand small { display: none; }
  .auth-main { place-items: start center; }
  .top-in { padding: 10px 16px; }
  .top .nav { order: 3; flex-basis: 100%; overflow-x: auto; }
  .top-user { margin-left: auto; }
  .reader { padding: 24px 16px 48px; }
  th, td { padding-left: 14px; padding-right: 14px; }
}
`;

/** Progressive enhancement only: every page works without it. */
export const APP_JS = String.raw`"use strict";
(function () {
  document.addEventListener("submit", function (event) {
    var form = event.target;
    var question = form.getAttribute("data-confirm");
    if (question && !window.confirm(question)) return event.preventDefault();
    var areas = form.querySelectorAll("textarea[data-json]");
    for (var i = 0; i < areas.length; i++) {
      try {
        JSON.parse(areas[i].value.trim() === "" ? "{}" : areas[i].value);
        areas[i].setCustomValidity("");
      } catch (error) {
        event.preventDefault();
        areas[i].setCustomValidity("This is not valid JSON. " + error.message);
        areas[i].reportValidity();
        return;
      }
    }
  });

  document.addEventListener("input", function (event) {
    if (event.target.matches && event.target.matches("textarea[data-json]")) event.target.setCustomValidity("");
  });

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-copy]") : null;
    if (!button || !navigator.clipboard) return;
    var source = document.querySelector(button.getAttribute("data-copy"));
    if (!source) return;
    navigator.clipboard.writeText(source.textContent).then(function () {
      button.textContent = "Copied";
    });
  });
})();
`;

/** Short fingerprint of a text, used as `?v=` so browsers can cache it for good. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
