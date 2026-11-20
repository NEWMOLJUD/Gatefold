// npm run watcher:install [SECONDS]
// Install a watcher that checks this repository's remote every SECONDS
// (default 60), pulls new commits and restarts the service.
import { fail, ok, preflight, run } from "../engine/tools/cli.ts";
import { projectName } from "../engine/tools/project.ts";
import { installWatcher, installedState, requireSystemd } from "../engine/tools/service.ts";

preflight();
requireSystemd();
const name = projectName();
const seconds = Number(process.argv[2] ?? "60");
if (!Number.isInteger(seconds) || seconds < 5) fail(`"${process.argv[2]}" is not a number of seconds (5 or more).`, "Example: npm run watcher:install 60");
if (!installedState(name).service) fail("The watcher restarts the service, and the service is not installed yet.", "Run `npm run service:install` first.");
if (run("git", ["rev-parse", "--abbrev-ref", "@{u}"]).code !== 0) {
  fail("This folder is not a git checkout that follows a remote branch, so there is nothing to watch.", "Clone your repository with git (or run: git branch --set-upstream-to=origin/main), then try again.");
}

installWatcher(name, seconds);
ok(`Watcher installed: every ${seconds} seconds it pulls new commits from ${run("git", ["remote", "get-url", "origin"]).stdout.trim()} and restarts "${name}".`);
