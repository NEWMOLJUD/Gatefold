// The engine's own test. Run it after changing engine/, deps/ or scripts/:
//
//   node engine/selftest/run.ts
//
// It copies the project to a temporary folder, swaps in a fixture app that
// uses every capability (selftest/sandbox), and drives the real commands
// there: the test runner, the Linux runner behind its front door, a restart,
// Wrangler's own dev and deploy steps, and the restrict gates.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../tools/cli.ts";

const project = mkdtempSync(join(tmpdir(), "redoma-selftest-"));
const failures: string[] = [];
let checks = 0;
const children: ChildProcess[] = [];

function expect(condition: unknown, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures.push(what);
  console.error(`  ✗ ${what}${detail ? `\n      ${detail.trim().split("\n").slice(-12).join("\n      ")}` : ""}`);
}

function command(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, args, { cwd: project, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const wrangler = (...args: string[]) => command([join(project, "node_modules/wrangler/bin/wrangler.js"), ...args], { NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" });

/** Start a long-running command and wait until its output matches. */
async function start(args: string[], ready: RegExp): Promise<{ child: ChildProcess; output: () => string }> {
  const child = spawn(process.execPath, args, { cwd: project, env: { ...process.env, NO_COLOR: "1", X_LOCAL_EXPLORER: "false", WRANGLER_SEND_METRICS: "false" } });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  for (let waited = 0; waited < 90_000 && !ready.test(output) && child.exitCode === null; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready.test(output)) throw new Error(`"${args.join(" ")}" did not become ready:\n${output}`);
  return { child, output: () => output };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

const json = async (url: string, init?: RequestInit): Promise<any> => (await fetch(url, init)).json();

try {
  // ---- a throwaway project with the fixture app --------------------------
  for (const entry of ["engine", "deps", "scripts", "package.json", "package-lock.json", "tsconfig.json", "wrangler.jsonc"]) {
    cpSync(join(ROOT, entry), join(project, entry), { recursive: true });
  }
  cpSync(join(ROOT, "engine/selftest/sandbox"), join(project, "sandbox"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(project, "node_modules"), "dir");
  rmSync(join(project, "engine/restrict.lock.json"), { force: true });
  const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  pkg.redoma.restrict = false;
  writeFileSync(join(project, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

  console.log("1. every capability, through the test runner");
  const tests = command(["scripts/test.ts"]);
  expect(tests.code === 0 && /\d+ tests passed/.test(tests.output), "npm run test passes on the fixture app", tests.output);
  const config = readFileSync(join(project, "wrangler.jsonc"), "utf8");
  expect(config.includes('"r2_buckets"') && config.includes('"* * * * *"'), "wrangler.jsonc gained the R2 binding and the cron trigger because the app uses them");

  console.log("2. the Linux runner: front door, secrets, data that survives a restart");
  const port = 39000 + (process.pid % 900);
  const base = `http://127.0.0.1:${port}`;
  let runner = await start(["engine/runner.ts", String(port)], /Serving on port/);
  const missing = await json(`${base}/secret`);
  expect(/npm run secret set API_KEY/.test(missing.error) && /Variables and Secrets/.test(missing.error), "a missing secret names the local command and the dashboard path", JSON.stringify(missing));
  expect((await json(`${base}/boom`, { method: "POST" })).error === "Internal Server Error", "outside dev, error details stay out of responses");
  for (const path of ["/cdn-cgi/local/explorer/api", "/cdn-cgi/handler/scheduled", "/__redoma/status", "/cdn-cgi/local/r2/public/redoma-files/x"]) {
    expect((await fetch(base + path)).status === 404, `the front door hides ${path}`);
  }
  const direct = await json(`${base}/echo/x`, { headers: { "CF-Connecting-IP": "6.6.6.6" } });
  expect(direct.ip === "127.0.0.1", "a client cannot fake its address", JSON.stringify(direct));
  const proxied = await json(`${base}/echo/x`, { headers: { "X-Forwarded-For": "198.51.100.1, 203.0.113.9", "X-Forwarded-Proto": "https" } });
  expect(proxied.ip === "203.0.113.9" && proxied.proto === "https:", "a reverse proxy on the same machine is trusted for address and scheme", JSON.stringify(proxied));
  await fetch(`${base}/events`, { method: "POST", body: JSON.stringify({ kind: "kept", flag: false }) });
  await fetch(`${base}/blob/kept.txt`, { method: "PUT", body: "still here" });
  await stop(runner.child);

  writeFileSync(join(project, ".dev.vars"), "API_KEY='pa$$w0rd-${HOME}'\n");
  runner = await start(["engine/runner.ts", String(port)], /Serving on port/);
  expect((await json(`${base}/events`))[0]?.kind === "kept", "database rows survive a restart");
  expect((await (await fetch(`${base}/blob/kept.txt`)).text()) === "still here", "files survive a restart");
  expect((await json(`${base}/secret`)).length === 16, "a secret with $ characters reaches the app unchanged");
  const second = command(["engine/runner.ts", String(port + 1)]);
  expect(second.code !== 0 && /in use by the Linux service/.test(second.output), "a second runtime refuses to share the data folder", second.output);
  await stop(runner.child);

  console.log("3. Wrangler's own commands with the committed config");
  const dry = wrangler("deploy", "--dry-run");
  expect(dry.code === 0 && /env\.FILES/.test(dry.output), "npx wrangler deploy --dry-run builds, with the R2 binding", dry.output);
  const devPort = port + 2;
  const dev = await start([join(project, "node_modules/wrangler/bin/wrangler.js"), "dev", "--port", String(devPort), "--ip", "127.0.0.1", "--persist-to", join(project, ".data-wrangler"), "--show-interactive-dev-session=false"], /Ready on/);
  const at = Date.UTC(2026, 0, 5, 3, 0);
  let fired = await fetch(`http://127.0.0.1:${devPort}/cdn-cgi/local/scheduled?time=${at}`);
  if (fired.status === 404) fired = await fetch(`http://127.0.0.1:${devPort}/cdn-cgi/handler/scheduled?time=${at}`);
  const events = await json(`http://127.0.0.1:${devPort}/events`);
  expect(fired.ok && events.some((event: { kind: string }) => event.kind.startsWith("nightly 2026-01-05T03:00")), "a scheduled event reaches the Worker's scheduled handler and runs the due job", JSON.stringify(events));
  await stop(dev.child);

  console.log("4. restrict mode");
  expect(command(["scripts/restrict.ts", "on"]).code === 0, "restrict on accepts the fixture app");
  expect(command(["scripts/test.ts"]).code === 0, "the fixture app passes with the gates on");
  expect(command(["scripts/restrict.ts", "status"]).code === 0, "restrict status is clean right after locking");

  writeFileSync(join(project, "sandbox/bad.ts"), 'import { readFileSync } from "node:fs";\nexport const leak = readFileSync;\n');
  const badImport = command(["scripts/test.ts"]);
  expect(badImport.code !== 0 && /sandbox\/bad\.ts:1:\d+ {2}restrict mode: import of "node:fs" is not allowed/.test(badImport.output), "a forbidden import fails npm run test with file and line", badImport.output);
  const badDeploy = wrangler("deploy", "--dry-run");
  expect(badDeploy.code !== 0 && /import of "node:fs" is not allowed/.test(badDeploy.output), "the same import fails npx wrangler deploy", badDeploy.output);
  const badInstall = command(["engine/build.ts", "install"], { WORKERS_CI: "1" });
  expect(badInstall.code !== 0, "and fails the install-time check on Cloudflare's builders");
  const badRunner = command(["engine/runner.ts", String(port + 3)]);
  expect(badRunner.code !== 0 && /restrict mode blocks this code/.test(badRunner.output), "and the Linux runner refuses to serve it", badRunner.output);

  writeFileSync(join(project, "sandbox/bad.ts"), 'export const call = () => fetch("https://example.com");\n');
  const badGlobal = command(["scripts/test.ts"]);
  expect(badGlobal.code !== 0 && /sandbox\/bad\.ts:1:\d+ {2}restrict mode: `fetch` is not available/.test(badGlobal.output), "a forbidden global fails the check", badGlobal.output);
  rmSync(join(project, "sandbox/bad.ts"));

  expect(/needs a person at a terminal/.test(command(["scripts/restrict.ts", "off"]).output), "restrict off refuses without a terminal");
  expect(/needs a person at a terminal/.test(command(["scripts/secret.ts", "set", "X"]).output), "secret set refuses without a terminal");
  writeFileSync(join(project, "engine/tampered.ts"), "export {};\n");
  const status = command(["scripts/restrict.ts", "status"]);
  expect(status.code !== 0 && /engine\/tampered\.ts \(added\)/.test(status.output), "restrict status reports a protected file that changed", status.output);
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  for (const child of children) child.kill("SIGKILL");
  rmSync(project, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`\n✓ Self-test passed: ${checks} checks.`);
