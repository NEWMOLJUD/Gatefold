/**
 * Everything the app can reach. `sandbox/main.ts` default-exports a function
 * that receives one `Deps`. It runs once at startup and must not be async:
 * register routes and jobs in it, and do the work inside them.
 *
 *   server     answer HTTP requests            server.ts
 *   http       call other servers              http.ts
 *   databases  SQLite, created on first use    databases.ts
 *   files      store uploads and other blobs   files.ts
 *   secrets    read API keys by name           secrets.ts
 *   cron       run a function on a schedule    cron.ts
 *
 * Tests: testing.ts. Globals you may use: globals.ts. Files in
 * `sandbox/public/` are served as they are.
 * @example
 * export default function main({ server }: Deps) {
 *   server.route("GET", "/api/hello", () => Response.json({ hello: "world" }));
 * }
 */
export interface Deps {
  server: import("./server.ts").Server;
  http: import("./http.ts").Http;
  databases: import("./databases.ts").Databases;
  files: import("./files.ts").Files;
  secrets: import("./secrets.ts").Secrets;
  cron: import("./cron.ts").Cron;
}
