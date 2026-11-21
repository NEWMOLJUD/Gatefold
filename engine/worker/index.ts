// Worker entry point. Wrangler bundles this file; it wires the sandbox app to
// the platform. Nothing here is specific to one app.
import main from "../../sandbox/main.ts";
import { createEngine } from "./app.ts";
import type { Env } from "./env.ts";

export { Database } from "./databases.ts";

const engine = createEngine(main);

export default {
  fetch: (request, env) => engine.fetch(request, env),
  scheduled: (controller, env, ctx) => {
    const run = engine.scheduled(controller, env);
    ctx.waitUntil(run);
    return run;
  },
} satisfies ExportedHandler<Env>;
