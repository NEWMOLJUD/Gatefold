// npm run service:status
// Is the service running, on which port, and what did it log last?
import { preflight, say } from "../engine/tools/cli.ts";
import { projectName } from "../engine/tools/project.ts";
import { installedState, requireSystemd, serviceUnit, unitStatus, watcherUnit } from "../engine/tools/service.ts";

preflight();
requireSystemd();
const name = projectName();
const state = installedState(name);
if (!state.service) {
  say(`No service named "${name}" is installed. Install it with: npm run service:install`);
  process.exit(0);
}
const status = unitStatus(serviceUnit(name));
const running = status.active === "active";
say(`${running ? "✓" : "✗"} Service "${name}": ${running ? "running" : status.active} on port ${state.port} (http://localhost:${state.port}), start on boot: ${status.enabled}.`);
if (state.watcher) {
  const watcher = unitStatus(watcherUnit(name), 3);
  say(`${watcher.active === "active" ? "✓" : "✗"} Watcher: ${watcher.active}, checks the remote every ${state.seconds} seconds.${watcher.log.length > 0 ? ` Last: ${watcher.log.at(-1)}` : ""}`);
} else {
  say("  Watcher: not installed (npm run watcher:install pulls new commits automatically).");
}
say("Recent log lines:");
for (const line of status.log) say(`  ${line}`);
if (status.log.length === 0) say("  (none)");
if (!running) process.exit(1);
