// npm run doctor
// Looks at this installation and says what is wrong or worth knowing, without
// changing anything and without reading any secret. It does not reach the
// network unless asked: `npm run doctor -- --online` also looks for a newer
// version.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, preflight, run, say } from "../engine/tools/cli.ts";
import { isRestricted, projectName, readPackage } from "../engine/tools/project.ts";
import { CONFIG_FILE, DEFAULT_CONFIG, parseConfig } from "../sandbox/config.ts";
import { LABEL, LABEL_MERGED, MANIFEST, SCRIPTS, compareVersions, locallyChanged, parseVersion, readManifest, releasedVersions, sourceUrl } from "./lib.ts";

preflight();

let problems = 0;
let warnings = 0;
const good = (line: string): void => say(`✓ ${line}`);
const note = (line: string, next?: string): void => {
  warnings++;
  say(`! ${line}${next ? `\n  → ${next}` : ""}`);
};
const bad = (line: string, next?: string): void => {
  problems++;
  say(`✗ ${line}${next ? `\n  → ${next}` : ""}`);
};

// The app -----------------------------------------------------------------

const manifest = readManifest();
if (!manifest) bad(`There is no readable ${MANIFEST}: this installation does not know which version it is.`, "Run `npm run update`.");
else {
  const changed = locallyChanged(manifest);
  if (changed.length === 0) good(`Gatefold ${manifest.version}, every file as released.`);
  else note(`Gatefold ${manifest.version}, with ${changed.length} file${changed.length === 1 ? "" : "s"} that differ from the release (${changed.slice(0, 4).map((line) => line.slice(2)).join(", ")}${changed.length > 4 ? ", ..." : ""}).`,
    "If that was not on purpose, `npm run repair` puts them back. `node gatefold/update.ts status` lists them all.");
}

const pkg = readPackage();
const missing = Object.keys(SCRIPTS).filter((name) => !(pkg.scripts?.[name] ?? "").includes(SCRIPTS[name]!));
if (missing.length === 0) good("The commands update, repair and doctor are in package.json.");
else bad(`package.json is missing the commands: ${missing.join(", ")}. (The machinery's own update rewrites that list.)`, "Run `node gatefold/update.ts check --fix`.");

const tree = run("git", ["status", "--porcelain"]);
if (tree.code !== 0) bad("This folder is not a git repository: updates cannot be reviewed or undone.", "Run `git init` and commit your work.");
else if (tree.stdout.trim() !== "") note("There are changes that are not committed.", "Commit them before `npm run update`: it refuses to start otherwise.");
else good("Everything is committed.");

// The brand ---------------------------------------------------------------

for (const file of ["label.json", "theme.css", "app.css"]) {
  if (!existsSync(join(ROOT, LABEL, file))) bad(`${LABEL}/${file} is missing: the pages have no ${file === "label.json" ? "name" : "design"}.`, "`npm run repair -- --label` puts the stylesheet back as it ships.");
}
for (const file of LABEL_MERGED) {
  if (existsSync(join(ROOT, LABEL, `${file}.new`))) {
    note(`${LABEL}/${file}.new is waiting: the last update could not merge the new rules into your ${file}.`, `Bring the new rules into ${file} by hand, then delete ${file}.new.`);
  }
}
const label = existsSync(join(ROOT, LABEL, "label.json")) ? readFileSync(join(ROOT, LABEL, "label.json"), "utf8") : "{}";
try {
  JSON.parse(label);
} catch {
  bad(`${LABEL}/label.json is not valid JSON: the default name is shown instead of yours.`);
}

// Where it runs -----------------------------------------------------------

let config = DEFAULT_CONFIG;
const configPath = join(ROOT, "sites", CONFIG_FILE);
if (existsSync(configPath)) {
  try {
    config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    config = { ...DEFAULT_CONFIG, problems: [`sites/${CONFIG_FILE} is not valid JSON.`] };
  }
  if (config.problems.length === 0) good(`sites/${CONFIG_FILE}: the visitor's address comes from "${config.client_ip}"${config.public_url ? `, and the public address is ${config.public_url}` : ""}.`);
  for (const problem of config.problems) bad(`sites/${CONFIG_FILE}: ${problem}`);
}
// A service installed on this machine means Linux, where nothing sets Cloudflare's header.
const unit = run("systemctl", ["--user", "is-enabled", `${projectName()}.service`]);
if (unit.code === 0 && config.client_ip === "cloudflare") {
  note(`This machine runs the app as a service, and the visitor's address is read from Cloudflare's header. Unless Cloudflare is in front of it, any visitor can write that header.`,
    `Set "client_ip" in sites/${CONFIG_FILE} to the header your reverse proxy sets, or to "none". See "Behind a reverse proxy" in the README.`);
}
if (unit.code === 0 && !config.public_url) {
  note("This machine runs the app as a service and no public address is set.", `Behind a reverse proxy with HTTPS, set "public_url" in sites/${CONFIG_FILE}: access links are built from it.`);
}
if (isRestricted()) good("Restrict mode is on.");

// Newer versions ----------------------------------------------------------

if (process.argv.includes("--online")) {
  const released = releasedVersions(sourceUrl());
  const current = manifest ? parseVersion(manifest.version) : null;
  if (!released) note(`${sourceUrl()} could not be reached.`, "A private repository needs your SSH key or credential helper.");
  else if (released.length === 0) good("The source has no released version yet.");
  else if (!current || compareVersions(released[0]!.version, current) > 0) note(`${released[0]!.tag} is available.`, "Run `npm run update`.");
  else good("This is the newest version.");
}

say("");
say("Not checked here: the three secrets (see them with `npm run secret list`), and the data, which only a backup protects.");
if (problems > 0) {
  say(`\n${problems} problem${problems === 1 ? "" : "s"}${warnings > 0 ? ` and ${warnings} thing${warnings === 1 ? "" : "s"} to look at` : ""}.`);
  process.exit(1);
}
say(warnings > 0 ? `\nNo problems, ${warnings} thing${warnings === 1 ? "" : "s"} to look at.` : "\nEverything looks right.");
