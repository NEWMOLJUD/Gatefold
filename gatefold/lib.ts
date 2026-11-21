// What the Gatefold commands share: which files belong to the app, the
// manifest that records them, versions, and the few git calls they need.
//
// Two layers live in this repository. The machinery (engine/, deps/, scripts/
// and a few root files) comes from Redoma and has its own update code, which
// these commands call. The app (sandbox/, this folder and the documents at the
// root) is Gatefold's, and is what the manifest lists. sites/ belongs to the
// installation and is never replaced.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, run } from "../engine/tools/cli.ts";
import { readPackage } from "../engine/tools/project.ts";

/** Where new versions come from, unless package.json says otherwise (`"gatefold": { "source": "..." }`). */
export const DEFAULT_SOURCE = "https://github.com/newmoljud/moljud-pages.git";

export const MANIFEST = "gatefold/manifest.json";
/** The stylesheets as they ship, kept so that an update can tell what an installation changed in its own. */
export const DEFAULTS = "gatefold/defaults";
export const LABEL = "sites/label";
/** The label files an update may improve. The others (name, logo, colours) are only ever the installation's. */
export const LABEL_MERGED = ["app.css"];
export const LABEL_DEFAULTS = ["app.css", "theme.css", "label.json"];

/** Folders that are the app, whole. */
export const OWNED_FOLDERS = ["sandbox", "gatefold"];
/** Documents at the root that describe the app. An installation that rewrote one keeps its own. */
export const OWNED_DOCS = ["README.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "LICENSE", "LICENSE-SUPPLEMENT.md", "THIRD_PARTY_NOTICES.md"];
/** The commands the app adds to package.json. The machinery's own update stays reachable as `update:engine`. */
export const SCRIPTS: Record<string, string> = {
  update: "gatefold/update.ts",
  repair: "gatefold/update.ts repair",
  doctor: "gatefold/doctor.ts",
  "update:engine": "scripts/update.ts",
};

export interface Manifest {
  /** The version of the app these files are. */
  version: string;
  /** Path → fingerprint of every file of the app, as released. */
  files: Record<string, string>;
}

/** A fingerprint that is the same on Windows and on Linux: line endings do not count. */
export function fingerprint(content: Buffer | string): string {
  const text = typeof content === "string" ? content : content.toString("utf8");
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

function walk(base: string, folder: string, files: string[]): void {
  const directory = join(base, folder);
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory).sort()) {
    const path = `${folder}/${entry}`;
    if (statSync(join(base, path)).isDirectory()) walk(base, path, files);
    else if (path !== MANIFEST) files.push(path);
  }
}

/** Every file of the app under `base`, as project-relative paths. */
export function ownedFiles(base: string): string[] {
  const files: string[] = [];
  for (const folder of OWNED_FOLDERS) walk(base, folder, files);
  for (const file of OWNED_DOCS) if (existsSync(join(base, file))) files.push(file);
  return files;
}

export function buildManifest(base: string, version: string): Manifest {
  const files: Record<string, string> = {};
  for (const file of ownedFiles(base)) files[file] = fingerprint(readFileSync(join(base, file)));
  return { version, files };
}

export function readManifest(base = ROOT): Manifest | null {
  const path = join(base, MANIFEST);
  if (!existsSync(path)) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    return typeof manifest.version === "string" && manifest.files !== null && typeof manifest.files === "object" ? manifest : null;
  } catch {
    return null;
  }
}

export function writeManifest(manifest: Manifest, base = ROOT): void {
  writeFileSync(join(base, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Files of the app that are not as the manifest says: "M" changed, "D" missing. */
export function locallyChanged(manifest: Manifest, base = ROOT): string[] {
  const lines: string[] = [];
  for (const [file, hash] of Object.entries(manifest.files)) {
    const path = join(base, file);
    if (!existsSync(path)) lines.push(`D ${file}`);
    else if (fingerprint(readFileSync(path)) !== hash) lines.push(`M ${file}`);
  }
  return lines.sort((a, b) => a.slice(2).localeCompare(b.slice(2)));
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export type Version = [major: number, minor: number, patch: number];

/** "1.2.3" or "v1.2.3". Pre-releases ("1.2.3-rc.1") are not versions an installation updates to. */
export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function sourceUrl(): string {
  const configured = (readPackage() as { gatefold?: { source?: unknown } }).gatefold?.source;
  return typeof configured === "string" && configured !== "" ? configured : DEFAULT_SOURCE;
}

/** An address with a password in it would end up committed in package.json and printed on the screen. */
export function hasCredentials(source: string): boolean {
  try {
    const url = new URL(source);
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
}

/** git must fail rather than stop to ask for a password nobody is there to type. */
export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** The released versions of `source`, newest first. `null` when it cannot be reached. */
export function releasedVersions(source: string): { tag: string; version: Version }[] | null {
  const listed = run("git", ["ls-remote", "--tags", "--refs", source], { env: GIT_ENV });
  if (listed.code !== 0) return null;
  const found: { tag: string; version: Version }[] = [];
  for (const line of listed.stdout.split("\n")) {
    const tag = line.split("refs/tags/")[1]?.trim();
    const version = tag ? parseVersion(tag) : null;
    if (tag && version && tag.startsWith("v")) found.push({ tag, version });
  }
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

/** The sections of a CHANGELOG.md for the versions after `from`, up to and including `to`, newest first. */
export function changelogBetween(text: string, from: Version | null, to: Version): string {
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## \[([^\]]+)\]/.exec(line);
    if (heading) {
      const version = parseVersion(heading[1]!);
      const wanted = version !== null && compareVersions(version, to) <= 0 && (from === null || compareVersions(version, from) > 0);
      current = wanted ? [line] : null;
      if (current) sections.push(current);
      continue;
    }
    // The link definitions at the foot of the file are not part of any section.
    if (/^\[[^\]]+\]: /.test(line)) current = null;
    if (current) current.push(line);
  }
  return sections.map((lines) => lines.join("\n").trimEnd()).join("\n\n");
}
