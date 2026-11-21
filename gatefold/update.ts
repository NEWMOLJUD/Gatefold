// npm run update [-- --to v1.2.3]     bring this installation to a newer Gatefold
// npm run repair [-- --label]         put back the files of the version installed
// node gatefold/update.ts status      what is installed, what is available, what was changed here
// node gatefold/update.ts check       is everything these commands depend on in place? (--fix puts it back)
//
// One download serves both layers. The Gatefold repository is cloned at a
// released tag; the machinery (engine/, deps/, scripts/) comes from that clone,
// so an installation always runs the machinery its version of the app was
// tested with, and then the app itself (sandbox/, this folder, the documents).
//
// sites/ is the installation's: its sources, its name, its logo and its
// colours are never replaced. The one file an update may touch there is
// sites/label/app.css, because new pages need new rules: an untouched copy is
// replaced, a changed one is merged, and when the merge does not fit the new
// rules are left beside it in app.css.new for a person to bring in.
//
// The data is not touched either. A new version may add to the database when
// it first runs (see MIGRATIONS in sandbox/core.ts), and that cannot be taken
// back by going back to the old code: back up before publishing an update.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT, fail, ok, preflight, run, say, warn } from "../engine/tools/cli.ts";
import { type PackageJson, readPackage, writePackage } from "../engine/tools/project.ts";
import { confirmByTyping, requireTerminal } from "../engine/tools/prompt.ts";
import { changes, replaceFolders } from "../engine/tools/update.ts";
import {
  DEFAULTS, DEFAULT_SOURCE, GIT_ENV, LABEL, LABEL_DEFAULTS, LABEL_MERGED, MANIFEST, type Manifest, OWNED_DOCS, SCRIPTS, buildManifest, changelogBetween,
  compareVersions, fingerprint, hasCredentials, locallyChanged, parseVersion, readManifest, releasedVersions, sourceUrl, writeManifest,
} from "./lib.ts";

const MODES = ["update", "repair", "status", "check", "finish"] as const;
type Mode = (typeof MODES)[number];

const args = process.argv.slice(2);
const mode: Mode = (MODES as readonly string[]).includes(args[0] ?? "") ? (args.shift() as Mode) : "update";
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

preflight();

if (mode === "finish") await finish(args[0]!, args[1]!, JSON.parse(args[2] ?? "{}") as FinishOptions);
else if (mode === "status") status();
else if (mode === "check") check();
else await start(mode);

// ---------------------------------------------------------------------------
// update and repair
// ---------------------------------------------------------------------------

interface FinishOptions {
  mode: "update" | "repair";
  /** Repair only: put the stylesheet back as it ships, over whatever the installation made of it. */
  label: boolean;
  /** Files of the machinery that change, for the last line of the report. */
  engine: number;
  from: string | null;
  head: string;
}

function undo(head: string): string {
  return `git reset --hard ${head.slice(0, 12)} && git clean -fd && npm install`;
}

/** Clone one released version and return where it landed. */
function fetchRelease(source: string, tag: string): string {
  const folder = mkdtempSync(join(tmpdir(), "gatefold-update-"));
  const cloned = run("git", ["-c", "advice.detachedHead=false", "clone", "--depth", "1", "--branch", tag, "--quiet", source, folder], { env: GIT_ENV });
  if (cloned.code !== 0) {
    rmSync(folder, { recursive: true, force: true });
    fail(`Could not download ${tag} from ${source}: ${cloned.stderr.trim().split("\n").at(-1) ?? "git clone failed"}`, `Check that \`git ls-remote ${source}\` works from this folder, then try again.`);
  }
  const looksRight = ["engine", "deps", "scripts", "sandbox", "package.json", MANIFEST].every((name) => existsSync(join(folder, name)));
  if (!looksRight) {
    rmSync(folder, { recursive: true, force: true });
    fail(`${tag} of ${source} is not a Gatefold release these commands can install (it has no ${MANIFEST}).`, "Choose a newer version with `--to`, or check the address in package.json (gatefold.source).");
  }
  return folder;
}

/** What installing `next` changes in the app, as "M path" / "A path" / "D path" lines. Documents the installation rewrote are left out: they are kept. */
function appChanges(installed: Manifest | null, next: Manifest): string[] {
  const lines: string[] = [];
  for (const [file, hash] of Object.entries(next.files)) {
    const path = join(ROOT, file);
    if (!existsSync(path)) lines.push(`A ${file}`);
    else if (fingerprint(readFileSync(path)) !== hash && !keptDocument(file, installed)) lines.push(`M ${file}`);
  }
  for (const file of Object.keys(installed?.files ?? {})) {
    if (!(file in next.files) && !OWNED_DOCS.includes(file) && existsSync(join(ROOT, file))) lines.push(`D ${file}`);
  }
  return lines.sort((a, b) => a.slice(2).localeCompare(b.slice(2)));
}

/** A document at the root that the installation rewrote: it is theirs now. */
function keptDocument(file: string, installed: Manifest | null): boolean {
  if (!OWNED_DOCS.includes(file) || !existsSync(join(ROOT, file))) return false;
  const shipped = installed?.files[file];
  return shipped === undefined || fingerprint(readFileSync(join(ROOT, file))) !== shipped;
}

function list(lines: string[], limit = 40): void {
  for (const line of lines.slice(0, limit)) say(`  ${line}`);
  if (lines.length > limit) say(`  ...and ${lines.length - limit} more`);
}

async function start(kind: "update" | "repair"): Promise<void> {
  const source = sourceUrl();
  if (hasCredentials(source)) fail("The address in package.json (gatefold.source) carries a password.", "Remove it from the address and let git ask for it (an SSH key or a credential helper).");

  const status = run("git", ["status", "--porcelain"]);
  if (status.code !== 0) fail("These commands need this folder to be a git repository: git is what lets you review and undo an update.", "Run `git init`, commit your work, then try again.");
  const dirty = status.stdout.split("\n").filter((line) => line.trim() !== "");
  if (dirty.length > 0) {
    process.stderr.write("✗ Not starting: these files have changes that are not committed. With everything committed, one command undoes the whole update.\n");
    for (const line of dirty.slice(0, 20)) process.stderr.write(`  ${line}\n`);
    if (dirty.length > 20) process.stderr.write(`  ...and ${dirty.length - 20} more\n`);
    fail("Commit them (or discard them), then run the command again.");
  }
  const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  requireTerminal(kind === "update" ? "Updating Gatefold" : "Repairing Gatefold", "it replaces the app and its machinery, so a person has to confirm it.");

  const installed = readManifest();
  const current = installed ? parseVersion(installed.version) : null;
  let tag: string;
  if (kind === "repair") {
    if (!installed || !current) fail(`There is no readable ${MANIFEST}, so there is no telling which version to put back.`, "Run `npm run update` instead: it installs the newest version.");
    tag = `v${installed.version}`;
  } else {
    const released = releasedVersions(source);
    if (!released) fail(`Could not reach ${source}.`, `Check that \`git ls-remote ${source}\` works from this folder (a private repository needs your SSH key or credential helper), then try again.`);
    const wanted = option("--to");
    const target = wanted ? released.find((release) => release.tag === (wanted.startsWith("v") ? wanted : `v${wanted}`)) : released[0];
    if (!target) fail(wanted ? `${source} has no version ${wanted}.` : `${source} has no released version yet.`, released.length > 0 ? `Available: ${released.slice(0, 8).map((release) => release.tag).join(", ")}` : undefined);
    if (current && compareVersions(target.version, current) === 0) {
      say(`Already on the newest version (${installed!.version}). To put its files back as they shipped, run \`npm run repair\`.`);
      return;
    }
    if (current && compareVersions(target.version, current) < 0 && !wanted) {
      say(`This installation (${installed!.version}) is newer than the newest release (${target.tag}). Nothing to do.`);
      return;
    }
    tag = target.tag;
  }

  const template = fetchRelease(source, tag);
  const shipped = readManifest(template);
  if (!shipped || `v${shipped.version}` !== tag) {
    rmSync(template, { recursive: true, force: true });
    fail(`${tag} of ${source} says it is version ${shipped?.version ?? "unknown"}: the release is not consistent.`, "Choose another version with `--to` and report this to whoever publishes the releases.");
  }
  const next = buildManifest(template, shipped.version);
  const machinery = changes(template);
  const app = appChanges(installed, next);
  const mine = installed ? locallyChanged(installed).filter((line) => !OWNED_DOCS.includes(line.slice(2))) : [];
  const documents = OWNED_DOCS.filter((file) => file in next.files && keptDocument(file, installed) && fingerprint(readFileSync(join(ROOT, file))) !== next.files[file]);

  say(kind === "update"
    ? `Gatefold ${installed?.version ?? "(version unknown)"} → ${shipped.version}`
    : `Gatefold ${shipped.version}: putting its files back as they shipped`);
  if (kind === "update") {
    const notes = changelogBetween(readFileSync(join(template, "CHANGELOG.md"), "utf8"), current, parseVersion(shipped.version)!);
    if (notes !== "") say(`\n${notes}\n`);
  }
  const label = LABEL_MERGED.map((file) => labelNote(file, labelOutcome(file, template, join(ROOT, DEFAULTS), kind === "repair" && flag("--label")), false)).filter((note) => note !== null);
  if (machinery.length + app.length + label.length === 0) {
    rmSync(template, { recursive: true, force: true });
    say("Nothing to change: every file is already as this version ships it.");
    return;
  }
  say(`${app.length} file${app.length === 1 ? "" : "s"} of the app and ${machinery.length} of its machinery change (M changed, A added, D deleted). Your sources, your brand and your data are not touched.`);
  list([...app, ...machinery]);
  for (const note of label) say(`The one file of sites/ an update may change: ${note}`);
  if (mine.length > 0) {
    warn("These files of the app were changed in this installation. They are replaced; git keeps what you had:");
    list(mine, 20);
  }
  if (documents.length > 0) say(`Kept as they are, because this installation rewrote them: ${documents.join(", ")}`);
  if (!installed) warn(`There is no ${MANIFEST} here, so what this installation changed cannot be told apart from what shipped. Review the result with \`git diff\`.`);
  say(`\nTo undo afterwards, before committing: ${undo(head)}`);
  say("Once the new version has run on your real data, going back to the old code is not enough: back up first.\n");
  if (!(await confirmByTyping(kind === "update" ? "Apply the update?" : "Repair the installation?", kind))) {
    rmSync(template, { recursive: true, force: true });
    fail("Cancelled. Nothing was changed.");
  }

  // What is here today is needed after it is replaced: to know what to delete, and what the installation changed.
  const before = mkdtempSync(join(tmpdir(), "gatefold-before-"));
  if (existsSync(join(ROOT, MANIFEST))) cpSync(join(ROOT, MANIFEST), join(before, "manifest.json"));
  if (existsSync(join(ROOT, DEFAULTS))) cpSync(join(ROOT, DEFAULTS), join(before, "defaults"), { recursive: true });

  replaceFolders(template);
  rmSync(join(ROOT, "gatefold"), { recursive: true, force: true });
  cpSync(join(template, "gatefold"), join(ROOT, "gatefold"), { recursive: true });
  // The rest is done by the code that was just copied in, so a new version decides how its own files land.
  const options: FinishOptions = { mode: kind, label: flag("--label"), engine: machinery.length, from: installed?.version ?? null, head };
  const finished = spawnSync(process.execPath, [join(ROOT, "gatefold", "update.ts"), "finish", template, before, JSON.stringify(options)], { stdio: "inherit" });
  process.exit(finished.status ?? 1);
}

type LabelOutcome =
  | { action: "none" }
  | { action: "restore" | "replace" }
  | { action: "merge"; content: string }
  | { action: "beside" };

/**
 * The stylesheet is the installation's file, and it holds every rule the
 * pages use. This decides what a new version does with it, without doing it:
 * `oldDefaults` is where the stylesheet of the installed version is, as it shipped.
 */
function labelOutcome(file: string, template: string, oldDefaults: string, restore: boolean): LabelOutcome {
  const mine = join(ROOT, LABEL, file);
  const base = join(oldDefaults, "label", file);
  const theirs = join(template, DEFAULTS, "label", file);
  if (!existsSync(theirs)) return { action: "none" };
  if (!existsSync(mine)) return { action: "restore" };
  const current = fingerprint(readFileSync(mine));
  const shipped = fingerprint(readFileSync(theirs));
  if (current === shipped) return { action: "none" };
  if (restore) return { action: "restore" };
  if (!existsSync(base)) return { action: "beside" };
  const before = fingerprint(readFileSync(base));
  // This version brings nothing new for the stylesheet: whatever the installation made of it stays.
  if (before === shipped) return { action: "none" };
  if (current === before) return { action: "replace" };
  const merged = run("git", ["merge-file", "-p", mine, base, theirs]);
  return merged.code === 0 ? { action: "merge", content: merged.stdout } : { action: "beside" };
}

/** What will be, or was, done with the stylesheet, in words. `null` when nothing is. */
function labelNote(file: string, outcome: LabelOutcome, done: boolean): string | null {
  const path = `${LABEL}/${file}`;
  if (outcome.action === "restore") return done ? `${path} was put back as it ships.` : `${path} is put back as it ships.`;
  if (outcome.action === "replace") return done ? null : `${path} gets the new rules (you have not changed it).`;
  if (outcome.action === "merge") return done ? `${path}: the new rules were merged into your version. Look at the pages before publishing.` : `${path} was changed here: the new rules are merged into your version.`;
  if (outcome.action === "beside") {
    return done
      ? `${path} was changed here in a way the new rules do not fit into by themselves. It was left as it is, and the stylesheet of this version is beside it in ${file}.new: bring the new rules in by hand, then delete ${file}.new.`
      : `${path} was changed here in a way the new rules do not fit into by themselves: it is left as it is, and the new stylesheet is put beside it as ${file}.new.`;
  }
  return null;
}

function applyLabel(file: string, template: string, outcome: LabelOutcome): void {
  const mine = join(ROOT, LABEL, file);
  const theirs = join(template, DEFAULTS, "label", file);
  if (outcome.action !== "none") rmSync(`${mine}.new`, { force: true });
  if (outcome.action === "restore" || outcome.action === "replace") {
    mkdirSync(dirname(mine), { recursive: true });
    cpSync(theirs, mine);
  } else if (outcome.action === "merge") writeFileSync(mine, outcome.content);
  else if (outcome.action === "beside") cpSync(theirs, `${mine}.new`);
}

/** The manifest this installation had before its files were replaced, if it had a readable one. */
function savedManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    return typeof manifest.version === "string" && manifest.files !== null && typeof manifest.files === "object" ? manifest : null;
  } catch {
    return null;
  }
}

async function finish(template: string, before: string, options: FinishOptions): Promise<void> {
  const installed = savedManifest(join(before, "manifest.json"));
  const shipped = readManifest(template)!;
  const next = buildManifest(template, shipped.version);
  const notes: string[] = [];

  // Files that left the app. Only what a release listed is ever deleted: a file the installation added stays.
  for (const file of Object.keys(installed?.files ?? {})) {
    if (!(file in next.files) && !OWNED_DOCS.includes(file)) rmSync(join(ROOT, file), { force: true });
  }
  const kept: string[] = [];
  for (const file of Object.keys(next.files)) {
    if (file.startsWith("gatefold/") || file === "README.md") continue;
    if (keptDocument(file, installed)) {
      if (fingerprint(readFileSync(join(ROOT, file))) !== next.files[file]) kept.push(file);
      continue;
    }
    mkdirSync(dirname(join(ROOT, file)), { recursive: true });
    cpSync(join(template, file), join(ROOT, file));
  }
  for (const file of LABEL_MERGED) {
    const outcome = labelOutcome(file, template, join(before, "defaults"), options.mode === "repair" && options.label);
    applyLabel(file, template, outcome);
    const note = labelNote(file, outcome, true);
    if (note) notes.push(note);
  }

  // The machinery's update keeps the README the installation has. It is replaced afterwards, unless the installation rewrote it.
  const readme = keptDocument("README.md", installed) ? null : readFileSync(join(template, "README.md"), "utf8");
  if (readme === null && fingerprint(readFileSync(join(ROOT, "README.md"))) !== next.files["README.md"]) kept.push("README.md");
  // With no dependencies of its own, the installation takes the exact versions this release was tested with.
  const pkg = readPackage();
  const theirs = readPackage(join(template, "package.json"));
  const ownDependencies = Object.keys(pkg.dependencies ?? {}).length > 0 || Object.keys(pkg.devDependencies ?? {}).some((name) => !(name in (theirs.devDependencies ?? {})));
  if (!ownDependencies && existsSync(join(template, "package-lock.json"))) cpSync(join(template, "package-lock.json"), join(ROOT, "package-lock.json"));
  rmSync(before, { recursive: true, force: true });

  // Root files, package.json, dependencies, the project's name, the restrict lock, and then the tests: the machinery's own second step.
  const engine = spawnSync(process.execPath, [join(ROOT, "scripts", "update.ts"), "finish", template, String(options.engine)], { stdio: "inherit" });
  if (readme !== null) writeFileSync(join(ROOT, "README.md"), readme);
  ensureScripts();

  if (kept.length > 0) notes.push(`Kept as they are, because this installation rewrote them: ${kept.join(", ")}. The versions of this release are in the Gatefold repository.`);
  for (const note of notes) warn(note);
  if ((engine.status ?? 1) !== 0) {
    fail(`Gatefold ${shipped.version} is in place, but the checks above did not pass.`, `Fix what they report and run \`npm run test\`, or undo: ${undo(options.head)}`);
  }
  ok(options.mode === "update"
    ? `Gatefold is now ${shipped.version}${options.from ? ` (it was ${options.from})` : ""}. Review with \`git diff\`, back up your data, then commit and publish.`
    : `Gatefold ${shipped.version} is back as it ships. Review with \`git diff\`, then commit.`);
}

// ---------------------------------------------------------------------------
// status and check
// ---------------------------------------------------------------------------

function status(): void {
  const installed = readManifest();
  const source = sourceUrl();
  say(`Installed: ${installed ? `Gatefold ${installed.version}` : `unknown (there is no readable ${MANIFEST})`}`);
  say(`Source:    ${source}`);
  const released = releasedVersions(source);
  if (!released) warn("The source could not be reached, so the newest version is not known.");
  else if (released.length === 0) say("Newest:    the source has no released version yet");
  else {
    const current = installed ? parseVersion(installed.version) : null;
    const newer = current ? compareVersions(released[0]!.version, current) > 0 : true;
    say(`Newest:    ${released[0]!.tag}${newer ? "  → run `npm run update`" : "  (up to date)"}`);
  }
  if (!installed) return;
  const changed = locallyChanged(installed);
  if (changed.length === 0) say("Files:     all as released");
  else {
    say(`Files:     ${changed.length} differ from the release (M changed, D missing)`);
    list(changed, 30);
  }
}

/** The commands of the app in package.json, as they must read. */
function wantedScripts(pkg: PackageJson): Record<string, string> {
  const prefix = Object.values(pkg.scripts ?? {}).find((command) => command.includes("redoma.preflight"))?.split(" && ")[0];
  const wanted: Record<string, string> = {};
  for (const [name, target] of Object.entries(SCRIPTS)) wanted[name] = `${prefix ? `${prefix} && ` : ""}node ${target}`;
  return wanted;
}

/** The machinery's update rewrites the list of commands from its template: put ours back. */
function ensureScripts(): boolean {
  const pkg = readPackage() as PackageJson & { gatefold?: { source?: string } };
  const wanted = wantedScripts(pkg);
  let changed = false;
  for (const [name, command] of Object.entries(wanted)) {
    if (pkg.scripts?.[name] !== command) {
      pkg.scripts = { ...pkg.scripts, [name]: command };
      changed = true;
    }
  }
  if (!pkg.gatefold?.source) {
    pkg.gatefold = { ...pkg.gatefold, source: DEFAULT_SOURCE };
    changed = true;
  }
  if (changed) writePackage(pkg);
  return changed;
}

/**
 * What these commands lean on, checked without touching the network: safe to
 * run in any installation and in CI. `--release` adds what must hold in the
 * Gatefold repository itself when a version is tagged; `--fix` puts back what
 * can be put back.
 */
function check(): void {
  const problems: string[] = [];
  const fixed: string[] = [];
  const release = flag("--release");
  const fix = flag("--fix");

  const pkg = readPackage() as PackageJson & { gatefold?: { source?: string }; version?: string };
  const wanted = wantedScripts(pkg);
  const missing = Object.entries(wanted).filter(([name, command]) => pkg.scripts?.[name] !== command).map(([name]) => name);
  if (missing.length > 0 || !pkg.gatefold?.source) {
    if (fix && ensureScripts()) fixed.push("package.json: the Gatefold commands were put back");
    else problems.push(`package.json is missing the Gatefold commands (${missing.join(", ") || "gatefold.source"}). Run \`node gatefold/update.ts check --fix\`.`);
  }

  // The machinery is someone else's code: what is called from it must still be there.
  const engine = existsSync(join(ROOT, "engine/tools/update.ts")) ? readFileSync(join(ROOT, "engine/tools/update.ts"), "utf8") : "";
  for (const name of ["changes", "replaceFolders"]) {
    if (!engine.includes(`export function ${name}(`)) problems.push(`engine/tools/update.ts no longer exports \`${name}\`: gatefold/update.ts has to follow the machinery's new shape.`);
  }
  const second = existsSync(join(ROOT, "scripts/update.ts")) ? readFileSync(join(ROOT, "scripts/update.ts"), "utf8") : "";
  if (!second.includes('"finish"')) problems.push('scripts/update.ts no longer has a "finish" step: gatefold/update.ts has to follow the machinery\'s new shape.');

  let manifest = readManifest();
  const version = /VERSION = "([^"]+)"/.exec(existsSync(join(ROOT, "sandbox/version.ts")) ? readFileSync(join(ROOT, "sandbox/version.ts"), "utf8") : "")?.[1];
  if (release && fix && version) {
    for (const file of LABEL_DEFAULTS) {
      mkdirSync(join(ROOT, DEFAULTS, "label"), { recursive: true });
      cpSync(join(ROOT, LABEL, file), join(ROOT, DEFAULTS, "label", file));
    }
    manifest = buildManifest(ROOT, version);
    writeManifest(manifest);
    fixed.push(`${MANIFEST} and ${DEFAULTS}/ were rebuilt for ${version}`);
  }
  if (!manifest) problems.push(`${MANIFEST} is missing or unreadable.`);
  else if (version !== manifest.version) problems.push(`sandbox/version.ts says ${version ?? "nothing"} and ${MANIFEST} says ${manifest.version}.`);

  if (release) {
    if (manifest) {
      if (pkg.version !== manifest.version) problems.push(`package.json says version ${pkg.version ?? "nothing"} and ${MANIFEST} says ${manifest.version}.`);
      const drift = [...locallyChanged(manifest), ...Object.keys(buildManifest(ROOT, manifest.version).files).filter((file) => !(file in manifest!.files)).map((file) => `A ${file}`)];
      if (drift.length > 0) problems.push(`${MANIFEST} does not describe the files as they are (${drift.slice(0, 5).join(", ")}${drift.length > 5 ? ", ..." : ""}). Run \`node gatefold/update.ts check --release --fix\`.`);
      if (!readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").includes(`## [${manifest.version}]`)) problems.push(`CHANGELOG.md has no section for ${manifest.version}.`);
    }
    for (const file of LABEL_DEFAULTS) {
      const shipped = join(ROOT, DEFAULTS, "label", file);
      if (!existsSync(shipped) || fingerprint(readFileSync(shipped)) !== fingerprint(readFileSync(join(ROOT, LABEL, file)))) {
        problems.push(`${DEFAULTS}/label/${file} is not a copy of ${LABEL}/${file}: installations merge against it.`);
      }
    }
  }

  for (const line of fixed) ok(line);
  if (problems.length > 0) {
    process.stderr.write(`✗ ${problems.length} problem${problems.length === 1 ? "" : "s"} with what the Gatefold commands depend on:\n`);
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    process.exit(1);
  }
  ok(release ? "Ready to release: the manifest, the versions and the default stylesheets agree." : "The Gatefold commands have what they depend on.");
}
