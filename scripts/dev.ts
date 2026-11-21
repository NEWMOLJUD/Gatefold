// npm run dev
// Run the app on this machine, on the first free port from 3000 upward.
// Reloads when files in sandbox/ change. Stop with Ctrl+C.
import { watch } from "node:fs";
import { check } from "../engine/tools/checks.ts";
import { DATA, SANDBOX, fail, formatProblem, ok, preflight, say, warn } from "../engine/tools/cli.ts";
import { type Runtime, StartError, firstFreePort, startRuntime, startTicking } from "../engine/tools/runtime.ts";

preflight();

const port = await firstFreePort(3000, 3999);
if (port === undefined) fail("No free port between 3000 and 3999.", "Close another local server and run `npm run dev` again.");

/** Gates and config upkeep. Type errors do not stop dev; `npm run test` reports them. */
async function inspect(): Promise<boolean> {
  const checked = await check({ types: false, config: "write" });
  for (const note of checked.notes) say(`! ${note}`);
  if (checked.problems.length === 0) return true;
  warn("The app is paused: the restrict lock blocks this code.");
  for (const problem of checked.problems) process.stderr.write(`  ${formatProblem(problem)}\n`);
  process.stderr.write("→ Fix the lines above; the app comes back when they are gone.\n");
  return false;
}

let runtime: Runtime | undefined;
let stopTicking = (): void => {};
let stopping = false;

async function start(): Promise<void> {
  try {
    runtime = await startRuntime({ mode: "dev", dataDir: DATA, listen: { port: port!, host: "127.0.0.1" }, onLog: say });
  } catch (error) {
    if (!(error instanceof StartError)) throw error;
    // A build error: keep watching, the next save may fix it.
    process.stderr.write(`✗ ${error.message}\n→ Fix it and save; the app starts again by itself.\n`);
    return;
  }
  const current = runtime;
  stopTicking = startTicking(current, warn);
  void current.exited.then((code) => {
    if (!stopping && runtime === current) fail(`The local runtime stopped unexpectedly (exit code ${code}).`, "Run `npm run dev` again.");
  });
  const status = await current.status();
  if (!status.ok) warn(`The app does not start: ${status.error}\n→ Fix it and save; it reloads by itself.`);
  ok(`Running at http://localhost:${port}  (Ctrl+C to stop)`);
}

async function stop(): Promise<void> {
  stopTicking();
  const current = runtime;
  runtime = undefined;
  await current?.stop();
}

if (await inspect()) await start();

// Wrangler reloads the Worker on its own. This watcher re-runs the gates and
// keeps wrangler.jsonc current, pausing the app while the lock is violated.
let timer: NodeJS.Timeout | undefined;
let busy = false;
watch(SANDBOX, { recursive: true }, (_event, name) => {
  if (name && String(name).split(/[\\/]/)[0] === "public") return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      const allowed = await inspect();
      if (!allowed && runtime) await stop();
      else if (allowed && !runtime) await start();
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  }, 250);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await stop();
    process.exit(0);
  });
}
