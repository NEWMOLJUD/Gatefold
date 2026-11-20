// npm run service:install [PORT or FROM:TO]
// Install the app as a systemd service that starts on boot and restarts on
// failure. PORT is a fixed port (default 3000); FROM:TO takes the first free
// port in that range. Running it again moves the service to the new port.
import { fail, ok, preflight, say } from "../engine/tools/cli.ts";
import { projectName } from "../engine/tools/project.ts";
import { firstFreePort } from "../engine/tools/runtime.ts";
import { enableBootStart, installService, installedState, requireSystemd, stopService } from "../engine/tools/service.ts";

preflight();
requireSystemd();
const name = projectName();
const spec = process.argv[2] ?? "3000";
const match = /^(\d+)(?::(\d+))?$/.exec(spec);
const from = Number(match?.[1]);
const to = Number(match?.[2] ?? match?.[1]);
if (!match || from < 1 || to > 65535 || from > to) {
  fail(`"${spec}" is not a port or a range.`, "Examples: npm run service:install 8080   or   npm run service:install 3000:3100");
}

// Our own running service must not make its port look taken.
if (installedState(name).service) stopService(name);
const port = await firstFreePort(from, to);
if (port === undefined) {
  fail(
    from === to ? `Port ${from} is already in use.` : `No free port between ${from} and ${to}.`,
    "Choose another port, or a range to take the first free one: npm run service:install 3000:3100",
  );
}

installService(name, port);
// Give it a moment, then make sure it really answers.
let up = false;
for (let attempt = 0; attempt < 60 && !up; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  up = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
}
if (!up) fail(`The service "${name}" was installed but is not answering on port ${port}.`, "Run `npm run service:status` to see why.");

ok(`Service "${name}" is running at http://localhost:${port} (all network interfaces). It restarts on failure and starts on boot.`);
const linger = enableBootStart();
if (linger) say(`! One step needs an administrator: to keep the service running after you log out and start it at boot, run once: ${linger}`);
say("  Its data lives in .data/ inside this folder: back that folder up. Secrets must be set on this machine too (npm run secret set NAME).");
