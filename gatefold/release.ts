// node gatefold/release.ts 1.2.3
// For whoever publishes Gatefold: writes the version everywhere it is said
// (package.json, sandbox/version.ts, the changelog), copies the stylesheets
// installations will merge against, and rebuilds the manifest. It commits
// nothing and tags nothing: it ends by saying how.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, fail, ok, preflight, run, say } from "../engine/tools/cli.ts";
import { readPackage, writePackage } from "../engine/tools/project.ts";
import { DEFAULTS, LABEL, LABEL_DEFAULTS, MANIFEST, buildManifest, compareVersions, parseVersion, readManifest, writeManifest } from "./lib.ts";

preflight();

const wanted = process.argv[2] ?? "";
const version = parseVersion(wanted);
if (!version || wanted.startsWith("v")) fail("Say the version to release, as three numbers.", "For example: node gatefold/release.ts 0.2.0");
const text = version.join(".");
const previous = readManifest()?.version ?? null;
const before = previous ? parseVersion(previous) : null;
if (before && compareVersions(version, before) <= 0) fail(`${text} is not newer than ${previous}, the version in ${MANIFEST}.`);
if (run("git", ["status", "--porcelain"]).stdout.trim() !== "") fail("There are changes that are not committed.", "Commit them first: a release is made from a known state.");

const pkg = readPackage() as ReturnType<typeof readPackage> & { version?: string; repository?: { url?: string } };
pkg.version = text;
writePackage(pkg);
writeFileSync(join(ROOT, "sandbox/version.ts"), readFileSync(join(ROOT, "sandbox/version.ts"), "utf8").replace(/VERSION = "[^"]*"/, `VERSION = "${text}"`));

// What is under "Unreleased" becomes this version; the links at the foot follow.
const home = (pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
const today = new Date().toISOString().slice(0, 10);
let changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
if (!changelog.includes("## [Unreleased]")) fail('CHANGELOG.md has no "## [Unreleased]" section to turn into this version.');
if (changelog.includes(`## [${text}]`)) fail(`CHANGELOG.md already has a section for ${text}.`);
changelog = changelog.replace("## [Unreleased]", `## [Unreleased]\n\n## [${text}] - ${today}`);
if (home !== "") {
  // A version only gets a "compare" link when the one before it was tagged.
  const tagged = previous !== null && run("git", ["tag", "--list", `v${previous}`]).stdout.trim() !== "";
  const link = tagged ? `${home}/compare/v${previous}...v${text}` : `${home}/releases/tag/v${text}`;
  changelog = changelog
    .replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${home}/compare/v${text}...HEAD\n[${text}]: ${link}`);
}
writeFileSync(join(ROOT, "CHANGELOG.md"), changelog);

mkdirSync(join(ROOT, DEFAULTS, "label"), { recursive: true });
for (const file of LABEL_DEFAULTS) cpSync(join(ROOT, LABEL, file), join(ROOT, DEFAULTS, "label", file));
writeManifest(buildManifest(ROOT, text));

ok(`Everything says ${text} now. Nothing was committed or tagged.`);
say("Next, in this order:");
say("  npm run test");
say("  node gatefold/update.ts check --release");
say(`  git add -A && git commit -m "Release ${text}"`);
say(`  git tag v${text}`);
say("  git push && git push --tags");
say(`Installations get it with \`npm run update\` once the tag v${text} is pushed.`);
