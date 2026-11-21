// npm run service:remove
// Stop and remove the systemd service (and the watcher, which would have
// nothing left to restart). The data in .data/ is kept.
import { ok, preflight, say } from "../engine/tools/cli.ts";
import { projectName } from "../engine/tools/project.ts";
import { removeService, removeWatcher, requireSystemd } from "../engine/tools/service.ts";

preflight();
requireSystemd();
const name = projectName();
const watcher = removeWatcher(name);
if (removeService(name)) ok(`Removed the service "${name}"${watcher ? " and its watcher" : ""}. The data in .data/ was kept.`);
else say(`No service named "${name}" is installed.${watcher ? " (Removed its watcher.)" : ""}`);
