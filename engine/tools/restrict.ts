// Restrict mode: the lock that keeps the app inside sandbox/.
//
// The switch lives in package.json (`redoma.restrict`). Turning it on also
// writes Claude Code deny rules to .claude/settings.json and records a
// fingerprint of every protected file in engine/restrict.lock.json, so
// `npm run restrict status` can tell when one of them changed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, rel } from "./cli.ts";
import { readPackage, writePackage } from "./project.ts";

export const CLAUDE_SETTINGS = join(ROOT, ".claude", "settings.json");
export const RECORD = join(ROOT, "engine", "restrict.lock.json");

const PROTECTED_FOLDERS = ["engine", "deps", "scripts"];
const PROTECTED_FILES = ["package.json", "package-lock.json", "tsconfig.json", "wrangler.jsonc", "AGENTS.md", "CLAUDE.md", ".gitignore"];

/** What Claude Code may not do while the lock is on. Paths starting with "/" are relative to the project root. */
export const DENY_RULES = [
  ...PROTECTED_FOLDERS.map((folder) => `Edit(/${folder}/**)`),
  ...PROTECTED_FILES.map((file) => `Edit(/${file})`),
  "Edit(/.claude/**)",
  "Edit(/.dev.vars)",
  "Read(/.dev.vars)",
  "Bash(npm run restrict *)",
  "Bash(npm run secret *)",
  "Bash(npm run update *)",
  "Bash(node scripts/restrict.ts *)",
  "Bash(node scripts/secret.ts *)",
  "Bash(node scripts/update.ts *)",
];

interface Settings {
  permissions?: { deny?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

function readSettings(): Settings {
  if (!existsSync(CLAUDE_SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as Settings;
  } catch {
    throw new Error(`${rel(CLAUDE_SETTINGS)} is not valid JSON. Fix or delete it, then run the command again.`);
  }
}

/** Add our deny rules, keeping whatever else the file contains. */
export function writeAgentRules(): void {
  const settings = readSettings();
  const deny = new Set([...(settings.permissions?.deny ?? []), ...DENY_RULES]);
  settings.permissions = { ...settings.permissions, deny: [...deny] };
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Remove exactly the rules we added. Deletes the file if nothing else is left in it. */
export function removeAgentRules(): void {
  if (!existsSync(CLAUDE_SETTINGS)) return;
  const settings = readSettings();
  const deny = (settings.permissions?.deny ?? []).filter((rule) => !DENY_RULES.includes(rule));
  if (settings.permissions) {
    if (deny.length > 0) settings.permissions.deny = deny;
    else delete settings.permissions.deny;
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
  }
  if (Object.keys(settings).length === 0) {
    rmSync(CLAUDE_SETTINGS);
    if (readdirSync(dirname(CLAUDE_SETTINGS)).length === 0) rmSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  } else {
    writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

export function missingAgentRules(): string[] {
  const deny = existsSync(CLAUDE_SETTINGS) ? (readSettings().permissions?.deny ?? []) : [];
  return DENY_RULES.filter((rule) => !deny.includes(rule));
}

/** Every protected file, as project-relative paths. wrangler.jsonc is generated, so it is checked by content elsewhere. */
function protectedFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path !== RECORD) files.push(rel(path));
    }
  };
  for (const folder of PROTECTED_FOLDERS) if (existsSync(join(ROOT, folder))) walk(join(ROOT, folder));
  for (const file of [...PROTECTED_FILES, rel(CLAUDE_SETTINGS)]) {
    if (file !== "wrangler.jsonc" && existsSync(join(ROOT, file))) files.push(file);
  }
  return files;
}

function fingerprint(file: string): string {
  return createHash("sha256").update(readFileSync(join(ROOT, file))).digest("hex");
}

/** Remember what the protected files look like right now. */
export function writeRecord(): void {
  const files: Record<string, string> = {};
  for (const file of protectedFiles()) files[file] = fingerprint(file);
  writeFileSync(RECORD, `${JSON.stringify({ note: "Fingerprints of the files restrict mode protects. Written by `npm run restrict on`.", files }, null, 2)}\n`);
}

export function removeRecord(): void {
  rmSync(RECORD, { force: true });
}

/** Protected files that differ from the record: changed, deleted or added since the lock was turned on. */
export function changedSinceLock(): string[] | undefined {
  if (!existsSync(RECORD)) return undefined;
  const recorded = (JSON.parse(readFileSync(RECORD, "utf8")) as { files: Record<string, string> }).files;
  const current = protectedFiles();
  const changes: string[] = [];
  for (const [file, hash] of Object.entries(recorded)) {
    if (!current.includes(file)) changes.push(`${file} (deleted)`);
    else if (fingerprint(file) !== hash) changes.push(`${file} (changed)`);
  }
  for (const file of current) if (!(file in recorded)) changes.push(`${file} (added)`);
  return changes;
}

export function setRestrictFlag(on: boolean): void {
  const pkg = readPackage();
  pkg.redoma = { ...pkg.redoma, restrict: on };
  writePackage(pkg);
}

/** Turn the lock on: flag, agent rules, then the record (last, so it covers the files just written). */
export function lock(): void {
  setRestrictFlag(true);
  writeAgentRules();
  writeRecord();
}

export function unlock(): void {
  setRestrictFlag(false);
  removeAgentRules();
  removeRecord();
}
