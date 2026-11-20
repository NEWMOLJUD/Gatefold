// The Linux runner: what the systemd service executes.
//   node engine/runner.ts PORT
// Starts the same Worker that runs on Cloudflare under the local runtime, with
// data in .data/, the front door on PORT (all network interfaces) and the
// every-minute cron tick. Exits non-zero if the runtime dies, so systemd
// restarts it.
import { check } from "./tools/checks.ts";
import { DATA, formatProblem, preflight } from "./tools/cli.ts";
import { StartError, startRuntime, startTicking } from "./tools/runtime.ts";

preflight();
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: node engine/runner.ts PORT");
  process.exit(2);
}

// The restrict lock applies here too: locked-out code does not get served.
const checked = await check({ types: false, config: "ignore" });
if (checked.problems.length > 0) {
  console.error("Not starting: restrict mode blocks this code.");
  for (const problem of checked.problems) console.error(`  ${formatProblem(problem)}`);
  process.exit(1);
}

try {
  const runtime = await startRuntime({ mode: "service", dataDir: DATA, listen: { port }, onLog: (line) => console.log(line) });
  const stopTicking = startTicking(runtime, (message) => console.error(message));
  const status = await runtime.status();
  console.log(status.ok ? `Serving on port ${port}.` : `Serving on port ${port}, but the app does not start: ${status.error}`);

  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      stopping = true;
      stopTicking();
      await runtime.stop();
      process.exit(0);
    });
  }
  const code = await runtime.exited;
  if (!stopping) {
    console.error(`The runtime stopped unexpectedly (exit code ${code}).`);
    await runtime.stop();
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof StartError ? error.message : error);
  process.exit(1);
}
