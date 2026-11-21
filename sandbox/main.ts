import type { Deps } from "../deps/index.ts";
import type { Server } from "../deps/server.ts";
import { registerApi } from "./api.ts";
import { DEFAULT_CONFIG, loadConfig, withHeaders } from "./config.ts";
import { type Ctx, MIGRATIONS, cleanup, purgeAudit } from "./core.ts";
import { registerPages } from "./pages.ts";

// Gatefold: publishes and manages read-only sites.
//
//   core.ts      database, authentication and the administrator and reader operations
//   audit.ts     the audit log: one row for every change, written with the change
//   config.ts    the installation's sites/gatefold.json, and the headers every answer carries
//   view.ts      serving the files of sites/sources/ (permission, props, rendering)
//   source-config.ts  the source.json of each source: rendered extensions and props
//   template.ts  template engine
//   pages.ts     /admin, /reader and /root pages
//   html.ts      page shells and building blocks; styles.ts is the built-in CSS and script
//   label.ts     white-label: name, logo and design read from sites/label/
//   api.ts       /api/admin, /api/reader and /api/root routes
export default function main({ server, databases, sites, secrets, cron }: Deps) {
  // A single database, with the identifier "gatefold".
  const ctx: Ctx = { db: databases.open("gatefold", MIGRATIONS), sites, secrets, config: DEFAULT_CONFIG };

  // Every route goes through here: the installation's settings are read before
  // the first one runs, and every answer leaves with the security headers.
  const routes: Server = {
    route(method, path, handler) {
      server.route(method, path, async (request, params) => {
        ctx.config = await loadConfig(sites);
        return withHeaders(request, await handler(request, params), ctx.config);
      });
    },
  };

  registerApi(routes, ctx);
  registerPages(routes, ctx);

  // Hourly cleanup of expired sessions and old root password attempt counts.
  cron.schedule("17 * * * *", (time) => cleanup(ctx, time));
  // Once a day: audit entries older than the retention period, which only root sets.
  cron.schedule("17 3 * * *", (time) => purgeAudit(ctx, time));
}
