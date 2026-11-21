// Everything that talks to Cloudflare, always through the Wrangler CLI.
// Nothing here assumes the CLI is logged in: many users publish by connecting
// their repository in the dashboard and never log in on this machine.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { check } from "./checks.ts";
import { STATE, WRANGLER_BIN, fail, failWithProblems, isInteractive, ok, run, runInteractive, saveLog, say, stripAnsi, wranglerEnv } from "./cli.ts";
import { projectName } from "./project.ts";

/** The click path to a Worker's secrets, used in every message that mentions it. */
export function dashboardSecretSteps(secret: string): string {
  return `Cloudflare dashboard → Workers & Pages → ${projectName()} → Settings → Variables and Secrets → Add → type "Secret", name ${secret}, paste the value → Deploy`;
}

function wrangler(args: string[], input?: string) {
  return run(process.execPath, [WRANGLER_BIN, ...args], { env: wranglerEnv(), input });
}

/** Can this terminal act on the Cloudflare account? True with an API token in the environment or after `wrangler login`. */
export function loggedIn(): boolean {
  if (process.env.CLOUDFLARE_API_TOKEN) return true;
  return wrangler(["whoami", "--json"]).code === 0;
}

export type RemoteSecrets = { state: "ok"; names: string[] } | { state: "not-deployed" } | { state: "error"; detail: string };

/** Names of the secrets on the deployed Worker. */
export function remoteSecrets(): RemoteSecrets {
  const result = wrangler(["secret", "list", "--format", "json"]);
  const text = stripAnsi(result.stdout + result.stderr);
  if (result.code === 0) {
    try {
      const start = result.stdout.indexOf("[");
      const list = JSON.parse(result.stdout.slice(start)) as { name: string }[];
      return { state: "ok", names: list.map((entry) => entry.name) };
    } catch {
      return { state: "error", detail: "could not read the list Cloudflare returned" };
    }
  }
  if (/10007|not found|does not exist|doesn't exist|wrangler deploy.{0,20}first/i.test(text)) return { state: "not-deployed" };
  return { state: "error", detail: firstError(text) };
}

export function putRemoteSecret(name: string, value: string): { ok: boolean; detail: string } {
  // The value travels on stdin: never in the arguments, never in a file.
  const result = wrangler(["secret", "put", name], value);
  return { ok: result.code === 0, detail: firstError(stripAnsi(result.stdout + result.stderr)) };
}

export function deleteRemoteSecret(name: string): { ok: boolean; detail: string } {
  const result = wrangler(["secret", "delete", name], "y\n");
  return { ok: result.code === 0, detail: firstError(stripAnsi(result.stdout + result.stderr)) };
}

function firstError(text: string): string {
  const lines = text.split("\n").map((line) => line.trim());
  const at = lines.findIndex((line) => line.startsWith("✘ [ERROR]"));
  const picked = at >= 0 ? lines.slice(at, at + 3) : lines.filter((line) => line !== "").slice(-2);
  return picked.join(" ").replace("✘ [ERROR] ", "").replace(/\s+/g, " ").trim();
}

/** The error block of a Wrangler run, without stack frames or its log-file footer. */
function errorExcerpt(text: string): string[] {
  const lines = stripAnsi(text).split("\n");
  const kept: string[] = [];
  let taking = false;
  for (const line of lines) {
    if (/^\[custom build\]/.test(line)) {
      const body = line.replace(/^\[custom build\]\s?/, "");
      if (body.trim() !== "" && !body.startsWith("Running:")) kept.push(body);
      continue;
    }
    if (line.startsWith("✘ [ERROR]")) taking = !/Process exited with non-zero status|Running custom build/.test(line);
    else if (/^(🪵|▲ \[WARNING\]|If you think this is a bug)/.test(line)) taking = false;
    if (taking && line.trim() !== "" && !/^\s+at |^\s+\[|^\s+_|^\s+[}\]]|^\s+\w+: /.test(line)) kept.push(line.replace("✘ [ERROR] ", ""));
  }
  return kept.slice(0, 40);
}

/** `npm run deploy` and `npm run deploy:check`. */
export async function deploy(options: { dryRun: boolean }): Promise<void> {
  const checked = await check({ types: true, config: "write" });
  if (checked.problems.length > 0) {
    failWithProblems(
      `Not ${options.dryRun ? "ready to publish" : "publishing"}: ${checked.problems.length} problem${checked.problems.length === 1 ? "" : "s"} found.`,
      checked.problems,
      "Fix them and run the command again.",
    );
  }
  const name = projectName();

  if (options.dryRun) {
    const outdir = join(STATE, "dry-run");
    const result = wrangler(["deploy", "--dry-run", "--outdir", outdir]);
    rmSync(outdir, { recursive: true, force: true });
    if (result.code !== 0) reportFailure("The app does not build for Cloudflare.", result.stdout + result.stderr, "deploy-check");
    for (const note of checked.notes) say(`! ${note}`);
    ok(`Ready to publish: "${name}" compiles and its configuration is valid${checked.restricted ? " (restrict gates passed)" : ""}. Nothing was uploaded.`);
    return;
  }

  const unattended = Boolean(process.env.CI || process.env.CLOUDFLARE_API_TOKEN);
  if (!unattended && !loggedIn()) {
    if (!isInteractive()) {
      fail(
        "This terminal is not logged in to Cloudflare, so nothing was published.",
        "Run `npm run deploy` yourself in a terminal to log in (a browser opens), or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID for unattended use. " +
          "If the repository is connected to Cloudflare through Git, just push: Cloudflare publishes it for you.",
      );
    }
    say("You are not logged in to Cloudflare on this machine yet. Starting the login: approve it in the browser, then come back here.");
    const remote = Boolean(process.env.SSH_CONNECTION) || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
    await runInteractive(process.execPath, [WRANGLER_BIN, "login", ...(remote ? ["--device"] : [])], wranglerEnv());
    if (!loggedIn()) fail("The login did not complete, so nothing was published.", "Run `npm run deploy` again and approve the login in the browser.");
  }

  mkdirSync(STATE, { recursive: true });
  const outputFile = join(STATE, "deploy-output.ndjson");
  rmSync(outputFile, { force: true });
  const env = wranglerEnv({ WRANGLER_OUTPUT_FILE_PATH: outputFile });
  let combined = "";
  let code: number;
  if (isInteractive()) {
    // Attached to the terminal: Wrangler may need to ask something on a first deploy.
    code = await runInteractive(process.execPath, [WRANGLER_BIN, "deploy"], env);
  } else {
    const result = run(process.execPath, [WRANGLER_BIN, "deploy"], { env });
    code = result.code;
    combined = result.stdout + result.stderr;
  }
  if (code !== 0) {
    const hint = /10042|not entitled|enable R2|R2 subscription/i.test(combined)
      ? "This app stores files, which needs R2 switched on for the Cloudflare account: dashboard → R2 → finish the one-time setup, then publish again."
      : /CLOUDFLARE_API_TOKEN|not authenticated/i.test(combined)
        ? "No Cloudflare credentials were found. Run `npm run deploy` in a terminal to log in, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID."
        : undefined;
    reportFailure("Cloudflare did not accept the deployment.", combined, "deploy", hint);
  }
  const url = deployedUrl(outputFile) ?? /https:\/\/[^\s"']+\.workers\.dev/.exec(stripAnsi(combined))?.[0];
  for (const note of checked.notes) say(`! ${note}`);
  ok(`Published "${name}"${url ? `: ${url}` : ". Find its address in the Cloudflare dashboard under Workers & Pages."}`);
}

function deployedUrl(outputFile: string): string | undefined {
  if (!existsSync(outputFile)) return undefined;
  for (const line of readFileSync(outputFile, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line) as { type?: string; targets?: string[] };
      const target = entry.type === "deploy" ? entry.targets?.find((item) => /^https?:\/\//.test(item) || item.includes(".")) : undefined;
      if (target) return target.startsWith("http") ? target : `https://${target.split(" ")[0]}`;
    } catch {
      // Not a JSON line.
    }
  }
  return undefined;
}

function reportFailure(headline: string, output: string, logName: string, hint?: string): never {
  process.stderr.write(`✗ ${headline}\n`);
  for (const line of errorExcerpt(output)) process.stderr.write(`  ${line}\n`);
  if (output.trim() !== "") process.stderr.write(`  Full log: ${saveLog(logName, output)}\n`);
  process.stderr.write(`→ ${hint ?? "Fix the error above and run the command again."}\n`);
  process.exit(1);
}
