// `npm run update`: replace the template's machinery (engine/, deps/, scripts/
// and the root files the template owns) with the latest upstream version.
// sandbox/ is never touched.
//
// A repository created with "Use this template" shares no history with the
// template, so there is nothing to merge: the template is cloned to a temporary
// folder and those paths are copied over. It runs in two steps. The first, in
// the code you have today, copies the folders. The second runs from the code
// that was just copied in, so a new version decides how its own files land.
//
// README.md is the one root file both sides write: the template owns the
// manual, the project owns the block between the two `redoma:project` markers.
// The update brings the new manual and puts the project's block back in it.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, fail, ok, run, say } from "./cli.ts";
import { type PackageJson, isRestricted, projectName, readPackage, writePackage } from "./project.ts";
import { applyName } from "./rename.ts";
import { RECORD, writeAgentRules, writeRecord } from "./restrict.ts";

const FOLDERS = ["engine", "deps", "scripts"];
/** Root files replaced as they are, except the project's block of README.md. package.json is merged and wrangler.jsonc regenerated. */
const ROOT_FILES = ["AGENTS.md", "CLAUDE.md", "README.md", "tsconfig.json", ".gitignore"];
const WATCHED = [...FOLDERS, ...ROOT_FILES, "package.json", "package-lock.json", "wrangler.jsonc"];

const HEADER_END = "<!-- /redoma:header -->";
const PROJECT_START = "<!-- redoma:project -->";
const PROJECT_END = "<!-- /redoma:project -->";

export function undoHint(): string {
  return `To undo the update: git checkout -- ${WATCHED.join(" ")} && git clean -fd ${FOLDERS.join(" ")}`;
}

/** Files under the protected paths that git sees as modified or untracked. */
export function uncommitted(): string[] {
  const status = run("git", ["status", "--porcelain", "--", ...WATCHED]);
  if (status.code !== 0) fail("`npm run update` needs this folder to be a git repository: git is what lets you review and undo the update.", "Run `git init`, commit your work, then try again.");
  return status.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => line.slice(3));
}

/** Clone the template and return where it landed. */
export function fetchTemplate(source: string): string {
  const folder = mkdtempSync(join(tmpdir(), "redoma-update-"));
  const cloned = run("git", ["clone", "--depth", "1", "--quiet", source, folder]);
  if (cloned.code !== 0) {
    rmSync(folder, { recursive: true, force: true });
    fail(`Could not download the template from ${source}: ${cloned.stderr.trim().split("\n").at(-1) ?? "git clone failed"}`, "Check the address in package.json (redoma.template) and your connection, then try again.");
  }
  const looksRight = FOLDERS.every((name) => existsSync(join(folder, name))) && existsSync(join(folder, "package.json"));
  if (!looksRight) {
    rmSync(folder, { recursive: true, force: true });
    fail(`${source} does not look like the template (engine/, deps/ and scripts/ are expected).`, "Check the address in package.json (redoma.template).");
  }
  return folder;
}

function listFiles(base: string, folder: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path !== RECORD) files.set(path.slice(base.length + 1).split("\\").join("/"), readFileSync(path, "latin1"));
    }
  };
  walk(join(base, folder));
  return files;
}

/** What the update would change, as "M path" / "A path" / "D path" lines. */
export function changes(template: string): string[] {
  const lines: string[] = [];
  for (const folder of FOLDERS) {
    const mine = listFiles(ROOT, folder);
    const theirs = listFiles(template, folder);
    for (const [path, content] of theirs) {
      if (!mine.has(path)) lines.push(`A ${path}`);
      else if (mine.get(path) !== content) lines.push(`M ${path}`);
    }
    for (const path of mine.keys()) if (!theirs.has(path)) lines.push(`D ${path}`);
  }
  for (const file of ROOT_FILES) {
    const theirs = join(template, file);
    if (!existsSync(theirs)) continue;
    const mine = join(ROOT, file);
    // README.md and AGENTS.md carry the project name here: ignore that difference by comparing after the first lines.
    if (!existsSync(mine)) lines.push(`A ${file}`);
    else if (body(readFileSync(mine, "utf8")) !== body(readFileSync(theirs, "utf8"))) lines.push(`M ${file}`);
  }
  if (JSON.stringify(mergePackage(readPackage(), readPackage(join(template, "package.json")))) !== JSON.stringify(readPackage())) lines.push("M package.json");
  return lines.sort((a, b) => a.slice(2).localeCompare(b.slice(2)));
}

/** A file's text without its name-carrying header and without the project's own block, for comparing a project's copy with the template. */
function body(text: string): string {
  const block = projectBlock(text);
  if (block !== null) text = text.replace(block, () => "");
  const end = text.indexOf(HEADER_END);
  if (end >= 0) return text.slice(end);
  return text.startsWith("# ") ? text.slice(text.indexOf("\n")) : text;
}

/** The part of README.md that belongs to the project, markers included, or null if the file has none. */
export function projectBlock(text: string): string | null {
  const start = text.indexOf(PROJECT_START);
  const end = text.indexOf(PROJECT_END);
  return start >= 0 && end > start ? text.slice(start, end + PROJECT_END.length) : null;
}

/** `text` with `block` as its project block. A README that has no block yet gets it right after the header. */
export function withProjectBlock(text: string, block: string): string {
  const current = projectBlock(text);
  if (current !== null) return text.replace(current, () => block);
  const header = text.indexOf(HEADER_END);
  if (header < 0) return `${block}\n\n${text}`;
  const at = header + HEADER_END.length;
  return `${text.slice(0, at)}\n\n${block}${text.slice(at)}`;
}

/** Step one: swap the three folders. */
export function replaceFolders(template: string): void {
  for (const folder of FOLDERS) {
    rmSync(join(ROOT, folder), { recursive: true, force: true });
    cpSync(join(template, folder), join(ROOT, folder), { recursive: true });
  }
  rmSync(RECORD, { force: true });
}

/** The template owns the tooling fields; the project keeps its identity, its own dependencies and its settings. */
function mergePackage(mine: PackageJson, theirs: PackageJson): PackageJson {
  const merged: PackageJson = { ...mine };
  for (const key of ["type", "engines", "scripts", "allowScripts"]) {
    if (theirs[key] !== undefined) merged[key] = theirs[key];
  }
  merged.devDependencies = { ...mine.devDependencies, ...theirs.devDependencies };
  merged.redoma = { ...theirs.redoma, ...mine.redoma, ...(theirs.redoma?.preflight ? { preflight: theirs.redoma.preflight } : {}) };
  return merged;
}

/** Step two, run by the freshly copied code: root files, dependencies, name, lock, then the same checks as `npm run test`. */
export async function finishUpdate(template: string, changed: number): Promise<void> {
  const name = projectName();
  const restricted = isRestricted();
  const readme = join(ROOT, "README.md");
  const kept = existsSync(readme) ? projectBlock(readFileSync(readme, "utf8")) : null;
  for (const file of ROOT_FILES) {
    if (existsSync(join(template, file))) cpSync(join(template, file), join(ROOT, file));
  }
  // The new README arrives with an empty project block: put back what the project had written in it.
  if (kept !== null && existsSync(readme)) writeFileSync(readme, withProjectBlock(readFileSync(readme, "utf8"), kept));
  writePackage(mergePackage(readPackage(), readPackage(join(template, "package.json"))));
  rmSync(template, { recursive: true, force: true });

  const installed = run("npm", ["install", "--no-audit", "--no-fund"]);
  if (installed.code !== 0) {
    process.stderr.write(installed.stderr);
    fail("The update was copied in, but `npm install` failed.", `Fix the error above and run \`npm install\`. ${undoHint()}`);
  }
  await applyName(name);
  if (restricted) {
    writeAgentRules();
    writeRecord();
  }

  say(`Updated ${changed} file${changed === 1 ? "" : "s"}. Checking your app against the new version...`);
  const tested = run(process.execPath, [join(ROOT, "scripts", "test.ts")]);
  if (tested.code !== 0) {
    process.stderr.write(tested.stdout + tested.stderr);
    fail("The update is in place, but your sandbox does not pass against it (see above).", `Adapt sandbox/ to the new deps/ and run \`npm run test\`. ${undoHint()}`);
  }
  ok(`Update complete and your sandbox still passes. Review with \`git diff\`, then commit.${restricted ? " The restrict lock was refreshed." : ""}`);
}
