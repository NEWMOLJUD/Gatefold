// Runtime configuration. There are two Wrangler configs, both generated here:
//
// - wrangler.jsonc in the project root is what Cloudflare deploys, from the
//   CLI or from a Git-connected build. It is committed. It lists only the
//   capabilities the sandbox actually uses, so an app that never touches
//   `files` deploys to an account without R2, and an app without cron jobs
//   takes none of the account's Cron Triggers.
// - a local config, written to .wrangler/redoma/ on every start, runs the same
//   Worker under the local runtime with every capability switched on.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC, ROOT, STATE, WRANGLER_CONFIG } from "./cli.ts";

/** Bump together with the pinned Wrangler version when the template is updated. */
export const COMPATIBILITY_DATE = "2026-11-01";

export interface Features {
  /** The sandbox uses `deps.files`: bind an R2 bucket. */
  files: boolean;
  /** The sandbox uses `deps.cron`: ask Cloudflare for the every-minute tick. */
  cron: boolean;
}

const HEADER = `// Generated from package.json and from what sandbox/ uses. Do not edit by hand:
// \`npm run dev\`, \`npm run test\` and \`npm run deploy\` keep it current.
// Commit this file whenever it changes: Cloudflare deploys from it.
`;

function shared(name: string) {
  return {
    name,
    compatibility_date: COMPATIBILITY_DATE,
    durable_objects: { bindings: [{ name: "DB", class_name: "Database" }] },
    exports: { Database: { type: "durable-object", storage: "sqlite" } },
  };
}

/** The committed config, as text. Deterministic: same inputs, same bytes. */
export function deployConfig(name: string, features: Features): string {
  const config: Record<string, unknown> = {
    $schema: "node_modules/wrangler/config-schema.json",
    ...shared(name),
    main: "engine/worker/index.ts",
    ...(existsSync(PUBLIC) ? { assets: { directory: "sandbox/public", binding: "ASSETS", not_found_handling: "404-page" } } : {}),
    ...(features.files ? { r2_buckets: [{ binding: "FILES", bucket_name: bucketName(name) }] } : {}),
    // An empty list removes the trigger; leaving the key out would keep an old one alive.
    triggers: { crons: features.cron ? ["* * * * *"] : [] },
    vars: { REDOMA_NAME: name },
    // Secrets and variables added in the dashboard survive every deploy.
    keep_vars: true,
    observability: { enabled: true },
    previews: {},
    // Runs inside `wrangler deploy`, also on Cloudflare's builders: type check, restrict gates.
    build: { command: "node engine/build.ts" },
  };
  return `${HEADER}${JSON.stringify(config, null, 2)}\n`;
}

export function bucketName(name: string): string {
  return `${name}-files`;
}

export interface SyncResult {
  /** The committed config did not match what the sandbox needs. */
  stale: boolean;
  /** Human description of the difference, for messages. */
  change: string;
}

/** Compare the committed config with what it should be; rewrite it when `write` is set. */
export function syncDeployConfig(name: string, features: Features, write: boolean): SyncResult {
  const wanted = deployConfig(name, features);
  const current = existsSync(WRANGLER_CONFIG) ? readFileSync(WRANGLER_CONFIG, "utf8") : "";
  if (current === wanted) return { stale: false, change: "" };
  const before = readFeatures(current);
  const parts: string[] = [];
  if (before.files !== features.files) parts.push(`file storage ${features.files ? "on" : "off"}`);
  if (before.cron !== features.cron) parts.push(`cron ${features.cron ? "on" : "off"}`);
  if (write) writeFileSync(WRANGLER_CONFIG, wanted);
  return { stale: true, change: parts.join(", ") || "settings refreshed" };
}

function readFeatures(text: string): Features {
  try {
    const config = JSON.parse(stripComments(text)) as { r2_buckets?: unknown[]; triggers?: { crons?: unknown[] } };
    return { files: (config.r2_buckets?.length ?? 0) > 0, cron: (config.triggers?.crons?.length ?? 0) > 0 };
  } catch {
    return { files: false, cron: false };
  }
}

/** Enough JSONC for the file this module writes: whole-line comments only. */
export function stripComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

export interface LocalOptions {
  /** A label for the generated file: "dev", "service", "test-1234". */
  id: string;
  name: string;
  vars: Record<string, string>;
}

/** Write the config for one local run and return its path. Absolute paths, every capability on. */
export function writeLocalConfig(options: LocalOptions): string {
  const config = {
    ...shared(options.name),
    main: join(ROOT, "engine", "worker", "index.ts"),
    ...(existsSync(PUBLIC) ? { assets: { directory: PUBLIC, binding: "ASSETS", not_found_handling: "404-page" } } : {}),
    r2_buckets: [{ binding: "FILES", bucket_name: bucketName(options.name) }],
    vars: { REDOMA_NAME: options.name, ...options.vars },
  };
  // One folder per run: Wrangler reads `.dev.vars` (the secrets) from next to its config.
  const folder = join(STATE, options.id);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "wrangler.jsonc");
  writeFileSync(path, `// Generated for one local run. Safe to delete.\n${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
