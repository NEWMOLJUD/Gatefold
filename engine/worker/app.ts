// Builds `deps`, runs the sandbox entry once, and dispatches requests and
// scheduled ticks to what the sandbox registered.
import type { Deps } from "../../deps/index.ts";
import type { Handler, Server } from "../../deps/server.ts";
import { type Job, parseCron } from "./cron.ts";
import { openDatabase } from "./databases.ts";
import { type Env, PublicError } from "./env.ts";
import { createFiles } from "./files.ts";
import { Router } from "./router.ts";

/** One running copy of the sandbox app. Tests get one each; production has one. */
interface Instance {
  router: Router;
  jobs: Job[];
  failure?: Error;
}

/** What the test runner declared for one test app. */
interface TestApp {
  secrets: Record<string, string>;
  http: boolean;
}

const CONTROL_HEADER = "x-redoma-control";
const SCOPE_HEADER = "x-redoma-scope";

export function createEngine(main: unknown) {
  const instances = new Map<string, Instance>();
  const tests = new Map<string, TestApp>();

  function instance(env: Env, scope: string): Instance {
    let found = instances.get(scope);
    if (!found) {
      found = start(env, scope);
      instances.set(scope, found);
    }
    return found;
  }

  function start(env: Env, scope: string): Instance {
    const created: Instance = { router: new Router(), jobs: [] };
    try {
      if (typeof main !== "function") {
        throw new TypeError("sandbox/main.ts must default-export a function: `export default function main(deps: Deps) { ... }`.");
      }
      const result: unknown = main(createDeps(env, scope, created));
      if (result instanceof Promise) {
        result.catch(() => {});
        throw new TypeError(
          "The function exported by sandbox/main.ts must not be async. Register routes and jobs right away, and do the awaiting inside them.",
        );
      }
    } catch (error) {
      created.failure = error instanceof Error ? error : new Error(String(error));
      console.error("The app failed to start:", created.failure);
    }
    return created;
  }

  function createDeps(env: Env, scope: string, target: Instance): Deps {
    const test = scope === "" ? undefined : tests.get(scope);
    const prefix = scope === "" ? "" : `${scope}/`;
    return {
      server: {
        route(method: Parameters<Server["route"]>[0], path: string, handler: Handler): void {
          target.router.add(method, path, handler);
        },
      },
      http: {
        fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
          return test ? mockedFetch(env, scope, test, new Request(input, init)) : fetch(input, init);
        },
      },
      databases: {
        open: (id, migrations) => openDatabase(env, prefix, id, migrations),
      },
      files: createFiles(env, prefix),
      secrets: {
        get(name: string): string {
          if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new TypeError(`secrets.get: ${JSON.stringify(name)} is not a valid secret name. Use letters, digits and "_", for example "RESEND_API_KEY".`);
          }
          const value = test ? test.secrets[name] : name.startsWith("REDOMA_") ? undefined : env[name];
          if (typeof value === "string" && value !== "") return value;
          throw new PublicError(test ? missingInTest(name) : missingSecret(name, env.REDOMA_NAME));
        },
      },
      cron: {
        schedule(expression: string, handler: (time: Date) => void | Promise<void>): void {
          if (typeof handler !== "function") throw new TypeError(`cron.schedule("${expression}"): the handler must be a function.`);
          target.jobs.push({ expression, matches: parseCron(expression), handler });
        },
      },
    };
  }

  async function fetchHandler(incoming: Request, env: Env): Promise<Response> {
    const url = new URL(incoming.url);
    const trusted = env.REDOMA_CONTROL !== undefined && incoming.headers.get(CONTROL_HEADER) === env.REDOMA_CONTROL;
    if (trusted && url.pathname.startsWith("/__redoma/")) return control(incoming, env, url);

    const scope = trusted ? (incoming.headers.get(SCOPE_HEADER) ?? "") : "";
    const app = instance(env, scope);
    if (app.failure) return failed(app.failure, env, "The app failed to start: ");

    const request = prepare(incoming, env, url);
    const match = app.router.match(request.method, url.pathname);
    if (!match) return notFound(request, env, app, url);
    try {
      const response: unknown = await match.handler(request, match.params);
      if (!(response instanceof Response)) {
        throw new TypeError(`The route for ${request.method} ${url.pathname} returned ${describe(response)} instead of a Response. Return one, for example Response.json(data).`);
      }
      return request.method === "HEAD" ? new Response(null, response) : response;
    } catch (error) {
      console.error(`${tag(scope)}${request.method} ${url.pathname} failed:`, error);
      return failed(error, env);
    }
  }

  async function scheduledHandler(controller: ScheduledController, env: Env): Promise<void> {
    const app = instance(env, "");
    if (app.failure) throw app.failure;
    await runDue(app, new Date(controller.scheduledTime), "");
  }

  /** Routes for the local runner and the test runner. Unreachable without the token. */
  async function control(request: Request, env: Env, url: URL): Promise<Response> {
    if (url.pathname === "/__redoma/status") {
      const app = instance(env, "");
      return Response.json({
        ok: !app.failure,
        error: app.failure?.message,
        cron: app.jobs.map((job) => job.expression),
        files: env.FILES !== undefined,
      });
    }
    if (url.pathname === "/__redoma/test" && request.method === "POST") {
      const { scope, secrets, http } = (await request.json()) as { scope: string; secrets?: Record<string, string>; http?: boolean };
      tests.set(scope, { secrets: secrets ?? {}, http: http === true });
      instances.delete(scope);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__redoma/cron" && request.method === "POST") {
      const { scope, time } = (await request.json()) as { scope: string; time: number };
      const app = instance(env, scope);
      if (app.failure) return Response.json({ ran: 0, errors: [`The app failed to start: ${app.failure.message}`] });
      const result = await runDue(app, new Date(time), scope);
      return Response.json(result);
    }
    return new Response("Unknown control route", { status: 404 });
  }

  return { fetch: fetchHandler, scheduled: scheduledHandler };
}

/** Test apps label their log lines, so the test runner can show each test only its own. */
function tag(scope: string): string {
  return scope === "" ? "" : `[${scope}] `;
}

async function runDue(app: Instance, time: Date, scope: string): Promise<{ ran: number; errors: string[] }> {
  const minute = new Date(Math.floor(time.getTime() / 60_000) * 60_000);
  const due = app.jobs.filter((job) => job.matches(minute));
  const errors: string[] = [];
  await Promise.all(
    due.map(async (job) => {
      const started = Date.now();
      try {
        await job.handler(minute);
        if (scope === "") console.log(`cron "${job.expression}" ran in ${Date.now() - started} ms`);
      } catch (error) {
        console.error(`${tag(scope)}cron "${job.expression}" failed:`, error);
        errors.push(`cron "${job.expression}" failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  return { ran: due.length, errors };
}

/** In tests `deps.http.fetch` is answered by the test's own `http` function, which lives in the test runner. */
async function mockedFetch(env: Env, scope: string, test: TestApp, request: Request): Promise<Response> {
  if (!test.http || !env.REDOMA_TEST_HTTP) {
    throw new Error(
      `deps.http.fetch("${request.url}") was called, but tests never reach the network. ` +
        "Give this test an `http` option that returns the response the app should receive: " +
        'test("name", { http: (request) => Response.json({ ok: true }) }, async (app) => { ... }).',
    );
  }
  const headers = new Headers({
    [SCOPE_HEADER]: scope,
    "x-redoma-url": request.url,
    "x-redoma-method": request.method,
    "x-redoma-headers": JSON.stringify([...request.headers]),
  });
  const body = request.body ? await request.arrayBuffer() : undefined;
  return fetch(env.REDOMA_TEST_HTTP, { method: "POST", headers, body });
}

/** Hide the runner's own headers from the app and restore the public scheme behind the Linux front door. */
function prepare(request: Request, env: Env, url: URL): Request {
  const internal = request.headers.has(CONTROL_HEADER) || request.headers.has(SCOPE_HEADER);
  const secure = env.REDOMA_FRONT === "1" && url.protocol === "http:" && request.headers.get("x-forwarded-proto") === "https";
  if (!internal && !secure) return request;
  if (secure) url.protocol = "https:";
  const prepared = new Request(url.toString(), request);
  prepared.headers.delete(CONTROL_HEADER);
  prepared.headers.delete(SCOPE_HEADER);
  return prepared;
}

async function notFound(request: Request, env: Env, app: Instance, url: URL): Promise<Response> {
  const allowed = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].filter((method) => app.router.match(method, url.pathname));
  if (allowed.length > 0) {
    return new Response(`${request.method} is not allowed on ${url.pathname}. Allowed: ${allowed.join(", ")}.\n`, {
      status: 405,
      headers: { allow: allowed.join(", ") },
    });
  }
  if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
    // Serves sandbox/public/404.html when the app has one.
    const page = await env.ASSETS.fetch(new Request(url.toString(), { method: request.method, headers: request.headers }));
    if (page.status !== 404 || page.headers.get("content-type")?.includes("text/html")) return page;
  }
  return new Response(`Not found: ${request.method} ${url.pathname}\n`, { status: 404 });
}

function failed(error: unknown, env: Env, prefix = ""): Response {
  const detail = error instanceof Error ? error.message : String(error);
  const visible = error instanceof PublicError || env.REDOMA_MODE === "dev";
  return Response.json({ error: visible ? prefix + detail : "Internal Server Error" }, { status: 500 });
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing (undefined)";
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function missingSecret(name: string, worker = "your Worker"): string {
  return (
    `Secret "${name}" is not set. ` +
    `On this machine (npm run dev, tests, the Linux service) run: npm run secret set ${name} . ` +
    `For the app published on Cloudflare, open the dashboard: Workers & Pages → ${worker} → Settings → ` +
    `Variables and Secrets → Add → type "Secret", name ${name}, paste the value → Deploy.`
  );
}

function missingInTest(name: string): string {
  return (
    `Secret "${name}" is not set in this test. Pass a made-up value in the test options: ` +
    `test("name", { secrets: { ${name}: "test-value" } }, async (app) => { ... }).`
  );
}
