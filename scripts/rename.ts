// npm run rename NAME
// Rename the project everywhere it is named: package.json, the Worker
// (wrangler.jsonc), README.md and AGENTS.md, and the systemd units if the
// Linux service is installed. Run it once, right after creating your
// repository from the template.
import { existsSync } from "node:fs";
import { DATA, fail, ok, preflight, say } from "../engine/tools/cli.ts";
import { isRestricted, nameProblem, projectName } from "../engine/tools/project.ts";
import { confirmByTyping, requireTerminal } from "../engine/tools/prompt.ts";
import { applyName } from "../engine/tools/rename.ts";
import { writeRecord } from "../engine/tools/restrict.ts";
import { installedState, reinstallAs } from "../engine/tools/service.ts";

preflight();
const name = process.argv[2];
if (!name) fail("Give the project a name.", "Example: npm run rename my-shop");
const problem = nameProblem(name);
if (problem) fail(`"${name}" cannot be used as the project name: ${problem}.`, "Example: npm run rename my-shop");

const previous = projectName();
if (previous === name) {
  say(`The project is already named "${name}".`);
  process.exit(0);
}

const restricted = isRestricted();
if (restricted) {
  requireTerminal("Renaming while restrict mode is on", "it rewrites protected files.");
  if (!(await confirmByTyping(`Rename "${previous}" to "${name}"? This rewrites protected files.`, "rename"))) fail("Cancelled. Nothing was changed.");
}

const service = installedState(previous);
await applyName(name);
if (restricted) writeRecord();
if (service.service || service.watcher) reinstallAs(previous, name, service);

ok(`Renamed "${previous}" to "${name}"${service.service ? " and moved the Linux service to the new name" : ""}.`);
if (existsSync(DATA)) {
  say(`! Data in .data/ was saved under the old name and stays there: the renamed app starts empty on this machine. Rename back to "${previous}" to see it again.`);
}
say(`! If "${previous}" was already published, the next deploy creates a new Worker named "${name}" with empty data and no secrets; the old one keeps running until you delete it in the Cloudflare dashboard.`);
