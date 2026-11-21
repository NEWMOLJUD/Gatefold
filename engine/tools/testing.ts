// Runs sandbox/**/*.test.ts against the real local runtime. This is the
// implementation behind deps/testing.ts.
//
// One runtime serves the whole run. Each test gets its own copy of the app
// inside it (own routes, databases, files, secrets), selected by a header the
// Worker only honours from this runner.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { App, TestOptions, Tests } from "../../deps/testing.ts";
import { rel } from "./cli.ts";
import { type Runtime, startRuntime } from "./runtime.ts";

export interface Failure {
  file: string;
  line: number;
  name: string;
  message: string;
  /** Errors the app logged while the test ran. */
  log: string[];
}

export interface TestReport {
  passed: number;
  failures: Failure[];
  /** Set when the app itself does not start: no test can pass. */
  startError?: string;
}

interface Registered {
  name: string;
  options: TestOptions;
  run: (app: App) => void | Promise<void>;
}

const TEST_TIMEOUT_MS = 30_000;

export async function runTests(files: string[]): Promise<TestReport> {
  const mocks = new Map<string, { answer: NonNullable<TestOptions["http"]>; errors: string[] }>();
  const mockServer = await startMockServer(mocks);
  const dataDir = mkdtempSync(join(tmpdir(), "redoma-test-"));
  let runtime: Runtime | undefined;
  const report: TestReport = { passed: 0, failures: [] };

  try {
    runtime = await startRuntime({
      mode: "test",
      dataDir,
      vars: { REDOMA_TEST_HTTP: `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}/` },
    });
    const status = await runtime.status();
    if (!status.ok) {
      report.startError = status.error ?? "unknown error";
      return report;
    }

    let counter = 0;
    for (const file of files) {
      let registered: Registered[];
      try {
        registered = await collect(file);
      } catch (error) {
        report.failures.push({ file: rel(file), line: 0, name: "(loading the file)", message: describe(error), log: [] });
        continue;
      }
      for (const test of registered) {
        const scope = `~test/${++counter}`;
        const mock = test.options.http ? { answer: test.options.http, errors: [] as string[] } : undefined;
        if (mock) mocks.set(scope, mock);
        try {
          await control(runtime, "/__redoma/test", { scope, secrets: test.options.secrets ?? {}, http: mock !== undefined });
          await withTimeout(Promise.resolve(test.run(createApp(runtime, scope))), test.name);
          if (mock && mock.errors.length > 0) throw new Error(`The test's \`http\` function threw: ${mock.errors[0]}`);
          report.passed++;
        } catch (error) {
          report.failures.push({
            file: rel(file),
            line: lineIn(error, file),
            name: test.name,
            message: describe(error),
            log: await appErrors(runtime, scope),
          });
        } finally {
          mocks.delete(scope);
        }
      }
    }
    return report;
  } finally {
    await runtime?.stop();
    mockServer.close();
    mockServer.closeAllConnections();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Import a test file and gather what it registers. */
async function collect(file: string): Promise<Registered[]> {
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (typeof module.default !== "function") {
    throw new Error("A test file must default-export a function: `export default function ({ test, assert }: Tests) { ... }`.");
  }
  const registered: Registered[] = [];
  const kit: Tests = {
    test(name: string, second: TestOptions | Registered["run"], third?: Registered["run"]): void {
      const run = typeof second === "function" ? second : third;
      if (typeof name !== "string" || typeof run !== "function") {
        throw new TypeError('test() takes a name and a function: test("does something", async (app) => { ... }).');
      }
      registered.push({ name, options: typeof second === "function" ? {} : second, run });
    },
    assert: createAssert(),
  };
  (module.default as (tests: Tests) => void)(kit);
  return registered;
}

function createAssert(): Tests["assert"] {
  const check = (value: unknown, message?: string): void => (message === undefined ? assert.ok(value) : assert.ok(value, message));
  return Object.assign(check, {
    equal: (actual: unknown, expected: unknown, message?: string): void =>
      message === undefined ? assert.deepStrictEqual(actual, expected) : assert.deepStrictEqual(actual, expected, message),
  });
}

function createApp(runtime: Runtime, scope: string): App {
  return {
    fetch(path: string, init?: RequestInit): Promise<Response> {
      if (typeof path !== "string" || !path.startsWith("/")) {
        throw new TypeError(`app.fetch: the path must start with "/" (got ${JSON.stringify(path)}).`);
      }
      const headers = new Headers(init?.headers);
      headers.set("x-redoma-control", runtime.token);
      headers.set("x-redoma-scope", scope);
      return fetch(runtime.origin + path, { ...init, headers, redirect: "manual" });
    },
    async runCron(time: string | Date): Promise<void> {
      const at = new Date(time).getTime();
      if (Number.isNaN(at)) throw new TypeError(`app.runCron: ${JSON.stringify(time)} is not a date. Example: "2026-01-01T03:00:00Z".`);
      const result = (await control(runtime, "/__redoma/cron", { scope, time: at })) as { errors: string[] };
      if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
    },
  };
}

async function control(runtime: Runtime, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(runtime.origin + path, {
    method: "POST",
    headers: { "x-redoma-control": runtime.token },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`The local runtime refused ${path} (${response.status}).`);
  return response.json();
}

/** Answers the app's `deps.http.fetch` calls with the current test's `http` function. */
function startMockServer(mocks: Map<string, { answer: NonNullable<TestOptions["http"]>; errors: string[] }>): Promise<http.Server> {
  const server = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", async () => {
      const mock = mocks.get(String(incoming.headers["x-redoma-scope"]));
      try {
        if (!mock) throw new Error("no test is waiting for this call");
        const method = String(incoming.headers["x-redoma-method"] ?? "GET");
        const request = new Request(String(incoming.headers["x-redoma-url"]), {
          method,
          headers: JSON.parse(String(incoming.headers["x-redoma-headers"] ?? "[]")) as [string, string][],
          body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
        });
        let answer: Response;
        try {
          answer = await mock.answer(request);
          if (!(answer instanceof Response)) throw new TypeError("it must return a Response");
        } catch (error) {
          mock.errors.push(describe(error));
          throw error;
        }
        const headers: Record<string, string> = {};
        answer.headers.forEach((value, name) => {
          if (name !== "content-length" && name !== "content-encoding" && name !== "transfer-encoding") headers[name] = value;
        });
        outgoing.writeHead(answer.status, headers).end(Buffer.from(await answer.arrayBuffer()));
      } catch (error) {
        outgoing.writeHead(500, { "content-type": "text/plain" }).end(`mocked http failed: ${describe(error)}`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function withTimeout(work: Promise<void>, name: string): Promise<void> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`"${name}" did not finish within ${TEST_TIMEOUT_MS / 1000} seconds.`)), TEST_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Line of the test file where the failure happened, from the stack trace. */
function lineIn(error: unknown, file: string): number {
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  for (const needle of [pathToFileURL(file).href, file]) {
    const at = stack.indexOf(`${needle}:`);
    if (at >= 0) return Number(/^(\d+)/.exec(stack.slice(at + needle.length + 1))?.[1] ?? 0);
  }
  return 0;
}

/** The errors this test's app logged (its lines carry the test's label), without the runtime's own stack frames. */
async function appErrors(runtime: Runtime, scope: string): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the last log lines arrive
  const label = `✘ [ERROR] [${scope}] `;
  const kept: string[] = [];
  let taking = false;
  for (const line of runtime.output) {
    if (line.startsWith("✘ [ERROR]")) taking = line.startsWith(label);
    else if (!/^\s/.test(line)) taking = false;
    if (!taking || line.trim() === "") continue;
    if (/node_modules|engine\/worker\//.test(line) && /^\s+at /.test(line)) continue;
    kept.push(line.replace(label, "").replace(/(\.\.\/)+(sandbox|deps|engine)\//g, "$2/"));
  }
  return kept.slice(0, 12);
}
