// Running the app as a systemd service on Linux, plus the optional watcher
// that pulls new commits and restarts it.
//
// Units are user-level (~/.config/systemd/user), so no sudo is involved and no
// root-owned file ever lands in the project. When the project itself belongs
// to root (a root-only VPS), system units in /etc/systemd/system are used.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { ROOT, fail, run } from "./cli.ts";

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const scope = asRoot ? [] : ["--user"];
const unitDir = asRoot ? "/etc/systemd/system" : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");

export const serviceUnit = (name: string): string => `${name}.service`;
export const watcherUnit = (name: string): string => `${name}-watcher.service`;
const unitPath = (unit: string): string => join(unitDir, unit);

function systemctl(...args: string[]) {
  return run("systemctl", [...scope, ...args]);
}

/** Stop with a plain explanation when this machine cannot run services. */
export function requireSystemd(): void {
  if (process.platform !== "linux") fail("The service commands work on Linux only (they use systemd).", "On this machine use `npm run dev`; to publish, use Cloudflare.");
  if (systemctl("show-environment").code !== 0) {
    fail(
      asRoot ? "systemd is not running on this machine." : "systemd's user services are not available in this session.",
      asRoot
        ? "This command needs a Linux system started by systemd (most servers are; containers usually are not)."
        : "Log in to the server normally (SSH or console) so that a user session exists, then run the command again.",
    );
  }
}

const quote = (value: string): string => `"${value.replace(/(["\\$%])/g, "\\$1")}"`;

function render(description: string, exec: string[], extra: string[] = []): string {
  return [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${ROOT}`,
    `ExecStart=${exec.map(quote).join(" ")}`,
    "Restart=always",
    "RestartSec=3",
    "TimeoutStopSec=20",
    ...extra,
    "",
    "[Install]",
    `WantedBy=${asRoot ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");
}

export function renderService(name: string, port: number): string {
  return render(`${name} (web app)`, [process.execPath, join(ROOT, "engine", "runner.ts"), String(port)]);
}

export function renderWatcher(name: string, seconds: number): string {
  // PATH lets the watcher find git and npm next to the Node that installed it.
  return render(`${name} watcher (pulls new commits and restarts ${name})`, [process.execPath, join(ROOT, "engine", "watcher.ts"), String(seconds)], [
    `Environment=${quote(`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)}`,
  ]);
}

export interface Installed {
  service: boolean;
  watcher: boolean;
  port?: number;
  seconds?: number;
}

/** What is installed under this project name, read from the unit files. */
export function installedState(name: string): Installed {
  const read = (unit: string, pattern: RegExp): number | undefined => {
    if (!existsSync(unitPath(unit))) return undefined;
    const found = pattern.exec(readFileSync(unitPath(unit), "utf8"))?.[1];
    return found ? Number(found) : 0;
  };
  const port = read(serviceUnit(name), /runner\.ts" "(\d+)"/);
  const seconds = read(watcherUnit(name), /watcher\.ts" "(\d+)"/);
  return { service: port !== undefined, watcher: seconds !== undefined, port, seconds };
}

function install(unit: string, content: string): void {
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath(unit), content);
  systemctl("daemon-reload");
  const started = systemctl("enable", "--now", unit);
  if (started.code !== 0) fail(`systemd could not start ${unit}: ${(started.stderr || started.stdout).trim()}`, "Run `npm run service:status` to see the log.");
  // A restart picks up a changed unit when the service was already running.
  systemctl("restart", unit);
}

function remove(unit: string): boolean {
  if (!existsSync(unitPath(unit))) return false;
  systemctl("disable", "--now", unit);
  rmSync(unitPath(unit), { force: true });
  systemctl("daemon-reload");
  systemctl("reset-failed", unit);
  return true;
}

export function installService(name: string, port: number): void {
  install(serviceUnit(name), renderService(name, port));
}

export function installWatcher(name: string, seconds: number): void {
  install(watcherUnit(name), renderWatcher(name, seconds));
}

export function removeService(name: string): boolean {
  return remove(serviceUnit(name));
}

export function removeWatcher(name: string): boolean {
  return remove(watcherUnit(name));
}

export function stopService(name: string): void {
  systemctl("stop", serviceUnit(name));
}

export function restartService(name: string): boolean {
  return systemctl("restart", serviceUnit(name)).code === 0;
}

/** User services stop at logout and do not start at boot unless "lingering" is on. Returns the command to run when we cannot enable it. */
export function enableBootStart(): string | undefined {
  if (asRoot) return undefined;
  const user = userInfo().username;
  if (/Linger=yes/.test(run("loginctl", ["show-user", user, "--property=Linger"]).stdout)) return undefined;
  if (run("loginctl", ["enable-linger", user]).code === 0) return undefined;
  return `sudo loginctl enable-linger ${user}`;
}

export interface ServiceStatus {
  active: string;
  enabled: string;
  log: string[];
}

export function unitStatus(unit: string, lines = 15): ServiceStatus {
  const active = systemctl("is-active", unit).stdout.trim() || "unknown";
  const enabled = systemctl("is-enabled", unit).stdout.trim() || "unknown";
  const journal = run("journalctl", [...(asRoot ? ["-u", unit] : ["--user-unit", unit]), "-n", String(lines), "--no-pager", "-o", "cat"]);
  return { active, enabled, log: journal.stdout.split("\n").filter((line) => line.trim() !== "") };
}

/** After a rename: move whatever was installed under the old name to the new one, same settings. */
export function reinstallAs(previous: string, name: string, state: Installed): void {
  if (state.watcher) removeWatcher(previous);
  if (state.service) removeService(previous);
  if (state.service && state.port) installService(name, state.port);
  if (state.watcher && state.seconds) installWatcher(name, state.seconds);
}
