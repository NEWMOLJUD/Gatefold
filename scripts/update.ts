// npm run update [ADDRESS]
// Bring the template's machinery (engine/, deps/, scripts/ and its root files)
// up to date with the upstream template. Never touches sandbox/. Refuses to
// run over uncommitted changes, shows what will change, and asks first.
// ADDRESS defaults to `redoma.template` in package.json.
import { spawnSync } from "node:child_process";
import { fail, preflight, say } from "../engine/tools/cli.ts";
import { templateUrl } from "../engine/tools/project.ts";
import { confirmByTyping, requireTerminal } from "../engine/tools/prompt.ts";
import { changes, fetchTemplate, finishUpdate, replaceFolders, uncommitted } from "../engine/tools/update.ts";

preflight();

// Second step, started below by the first one, running the code that was just copied in.
if (process.argv[2] === "finish") {
  await finishUpdate(process.argv[3]!, Number(process.argv[4] ?? 0));
  process.exit(0);
}

const source = process.argv[2] ?? templateUrl();
if (!source) fail("No template address is configured.", 'Add it to package.json: "redoma": { "template": "https://github.com/MateusMoutinhoOrg/Redoma.git" }');

const dirty = uncommitted();
if (dirty.length > 0) {
  process.stderr.write("✗ Not updating: these files have changes that are not committed, and the update would overwrite them:\n");
  for (const file of dirty.slice(0, 20)) process.stderr.write(`  ${file}\n`);
  if (dirty.length > 20) process.stderr.write(`  ...and ${dirty.length - 20} more\n`);
  process.stderr.write("→ Commit them (or discard them with `git checkout`), then run `npm run update` again.\n");
  process.exit(1);
}
requireTerminal("Updating the template", "it replaces engine/, deps/ and scripts/, so a person has to confirm it.");

const template = fetchTemplate(source);
const list = changes(template);
if (list.length === 0) {
  say("Already up to date: nothing in the template has changed.");
  process.exit(0);
}
say(`The update changes ${list.length} file${list.length === 1 ? "" : "s"} (M changed, A added, D deleted). sandbox/ is not touched.`);
for (const line of list.slice(0, 40)) say(`  ${line}`);
if (list.length > 40) say(`  ...and ${list.length - 40} more`);
if (!(await confirmByTyping("Apply the update?", "update"))) fail("Cancelled. Nothing was changed.");

replaceFolders(template);
const finished = spawnSync(process.execPath, [import.meta.filename, "finish", template, String(list.length)], { stdio: "inherit" });
process.exit(finished.status ?? 1);
