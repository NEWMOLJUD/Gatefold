// npm run watcher:remove
// Remove the watcher. The service keeps running the version it has.
import { ok, preflight, say } from "../engine/tools/cli.ts";
import { projectName } from "../engine/tools/project.ts";
import { removeWatcher, requireSystemd } from "../engine/tools/service.ts";

preflight();
requireSystemd();
if (removeWatcher(projectName())) ok("Watcher removed. The service keeps running; update it by hand with `git pull` and `npm run service:install`.");
else say("No watcher is installed.");
