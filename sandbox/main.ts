import type { Deps } from "../deps/index.ts";
import { registerApi } from "./api.ts";
import { type Ctx, MIGRATIONS, cleanup } from "./core.ts";
import { registerPages } from "./pages.ts";

// Gatefold: publishes and manages read-only sites.
//
//   core.ts      database, authentication and the administrator and reader operations
//   view.ts      serving the files of sites/sources/ (permission, props, rendering)
//   source-config.ts  the source.json of each source: rendered extensions and props
//   template.ts  template engine
//   pages.ts     /admin, /reader and /root pages
//   html.ts      page shells and building blocks; styles.ts is the built-in CSS and script
//   label.ts     white-label: name, logo and design read from sites/label/
//   api.ts       /api/admin, /api/reader and /api/root routes
export default function main({ server, databases, sites, secrets, cron }: Deps) {
  // A single database, with the identifier "gatefold".
  const ctx: Ctx = { db: databases.open("gatefold", MIGRATIONS), sites, secrets };

  registerApi(server, ctx);
  registerPages(server, ctx);

  // Hourly cleanup of expired sessions and old root password attempt counts.
  cron.schedule("17 * * * *", (time) => cleanup(ctx, time));
}
