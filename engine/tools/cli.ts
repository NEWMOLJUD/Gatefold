// Shared plumbing for the command scripts: paths, output, subprocesses.
// Output rule: one line on success; on failure say what went wrong, where,
// and the next step. Full tool output goes to a log file, not the terminal.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SANDBOX = join(ROOT, "sandbox");
export const PUBLIC = join(SANDBOX, "public");
export const DEPS = join(ROOT, "deps");
/** Everything the app stores (databases and files). The thing to back up. */
export const DATA = join(ROOT, ".data");
/** Scratch space for generated configs and logs. Safe to delete. */
export const STATE = join(ROOT, ".wrangler", "redoma");
/** Secrets for this machine. Git-ignored. */
export const SECRETS_FILE = join(ROOT, ".dev.vars");
export const WRANGLER_CONFIG = join(ROOT, "wrangler.jsonc");
export const WRANGLER_BIN = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

const MIN_NODE = [22, 18] as const;

/** Every command starts here: right Node version, dependencies installed, not sudo. */
export function preflight(options: { allowRoot?: boolean } = {}): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    fail(
      `This project needs Node.js ${MIN_NODE.join(".")} or newer. You have ${process.version}.`,
      "Install the current LTS version from https://nodejs.org, then run this command again.",
    );
  }
  try {
    statSync(WRANGLER_BIN);
  } catch {
    fail("The project's tools are not installed yet.", "Run `npm install`, then run this command again.");
  }
  if (!options.allowRoot) refuseSudo();
}

/**
 * Running as root inside a project owned by a normal user (the classic `sudo npm run ...`)
 * leaves root-owned files behind that break every later command. Refuse.
 */
export function refuseSudo(): void {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const owner = statSync(ROOT).uid;
  if (owner === 0) return;
  fail(
    "Do not run this command with sudo: it would leave root-owned files in the project and break later commands.",
    "Run it again as your normal user, without sudo.",
  );
}

export function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function ok(line: string): void {
  say(`✓ ${line}`);
}

export function warn(line: string): void {
  process.stderr.write(`! ${line}\n`);
}

/** Print the error and the next step, then exit. */
export function fail(what: string, next?: string): never {
  process.stderr.write(`✗ ${what}\n`);
  if (next) process.stderr.write(`→ ${next}\n`);
  process.exit(1);
}

/** Path relative to the project root, with forward slashes. */
export function rel(path: string): string {
  return relative(ROOT, path).split("\\").join("/");
}

export interface Problem {
  file: string;
  line: number;
  column: number;
  message: string;
}

export function formatProblem(problem: Problem): string {
  const where = problem.line > 0 ? `${problem.file}:${problem.line}:${problem.column}` : problem.file;
  return `${where}  ${problem.message}`;
}

/** Print problems in the `file:line:column  message` form and exit. */
export function failWithProblems(headline: string, problems: Problem[], next: string): never {
  process.stderr.write(`✗ ${headline}\n`);
  for (const problem of problems) process.stderr.write(`  ${formatProblem(problem)}\n`);
  process.stderr.write(`→ ${next}\n`);
  process.exit(1);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion and capture its output. Never throws on a non-zero exit. */
export function run(command: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    input: options.input,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return { code: 127, stdout: "", stderr: result.error.message };
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run a command attached to the terminal, so it can ask the user questions. */
export function runInteractive(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: "inherit" });
    child.on("error", () => done(127));
    child.on("exit", (code) => done(code ?? 1));
  });
}

/** Environment for every Wrangler child: quiet, no telemetry, no colors to parse around. */
export function wranglerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_HIDE_BANNER: "true",
    WRANGLER_NO_SKILLS_UPDATE_PROMPTS: "true",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...extra,
  };
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Keep the complete output of a tool for whoever needs the details. Returns the relative path. */
export function saveLog(name: string, content: string): string {
  const path = join(STATE, `${name}.log`);
  mkdirSync(STATE, { recursive: true });
  writeFileSync(path, stripAnsi(content));
  return rel(path);
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}
