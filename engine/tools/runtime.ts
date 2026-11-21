// The local runtime: the same Worker that runs on Cloudflare, under workerd
// (through `wrangler dev`), with data on disk. Used by `npm run dev`, by the
// tests and by the Linux service.
//
// workerd listens on a private loopback port. What the outside world talks to
// is the "front door" below, a small reverse proxy that refuses the runtime's
// own maintenance endpoints (/cdn-cgi/*: a data browser, public file access,
// manual triggers) and reports the real client address.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { ROOT, SECRETS_FILE, WRANGLER_BIN, stripAnsi, wranglerEnv } from "./cli.ts";
import { writeLocalConfig } from "./config.ts";
import { projectName } from "./project.ts";

export interface RuntimeOptions {
  mode: "dev" | "service" | "test";
  /** Where the databases and files live. */
  dataDir: string;
  /** Public address. Leave out to run without a front door (tests). */
  listen?: { port: number; host?: string };
  vars?: Record<string, string>;
  /** Receives what the app prints (console.log, request lines, errors) once it is up. */
  onLog?: (line: string) => void;
}

export interface AppStatus {
  ok: boolean;
  error?: string;
  cron: string[];
}

export interface Runtime {
  /** Direct address of the Worker, control routes included. Loopback only. */
  origin: string;
  /** Proves to the Worker that a request comes from this runner. */
  token: string;
  status(): Promise<AppStatus>;
  /** Run the cron jobs due at `time` (default: now). */
  tick(time?: Date): Promise<{ ran: number; errors: string[] }>;
  stop(): Promise<void>;
  /** Resolves with the exit code if the runtime dies on its own. */
  exited: Promise<number>;
  /** Everything the runtime printed, for failure reports. */
  output: string[];
}

export class StartError extends Error {}

export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const token = randomBytes(24).toString("hex");
  const id = options.mode === "test" ? `test-${process.pid}` : options.mode;
  const config = writeLocalConfig({
    id,
    name: projectName(),
    vars: {
      ...(options.mode === "service" ? { REDOMA_FRONT: "1" } : { REDOMA_MODE: "dev" }),
      REDOMA_CONTROL: token,
      ...options.vars,
    },
  });
  // Secrets reach the Worker through a private copy of .dev.vars next to the
  // config: Wrangler reads that file literally (its --env-file flag would
  // expand "$" inside values). Tests get no real secrets.
  const folder = dirname(config);
  if (options.mode !== "test" && existsSync(SECRETS_FILE)) {
    copyFileSync(SECRETS_FILE, join(folder, ".dev.vars"));
    chmodSync(join(folder, ".dev.vars"), 0o600);
  }
  mkdirSync(options.dataDir, { recursive: true });
  const release = lock(options.dataDir, options.mode);

  const port = await freePort();
  const args = [
    WRANGLER_BIN, "dev",
    "--config", config,
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--inspector-port", String(await freePort()),
    "--persist-to", options.dataDir,
    "--show-interactive-dev-session=false",
  ];

  const output: string[] = [];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: wranglerEnv({ X_LOCAL_EXPLORER: "false", X_LOCAL_OBSERVABILITY: "false" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const killOnExit = (): void => void child.kill("SIGKILL");
  process.once("exit", killOnExit);

  let ready = false;
  let onReady: () => void = () => {};
  const becameReady = new Promise<void>((resolve) => (onReady = resolve));
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  for (const stream of [child.stdout!, child.stderr!]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (pending + stripAnsi(chunk)).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        output.push(line);
        if (!ready && /Ready on https?:\/\//.test(line)) {
          ready = true;
          onReady();
        } else if (ready) {
          const shown = presentable(line);
          if (shown !== undefined) options.onLog?.(shown);
        }
      }
    });
  }

  const origin = `http://127.0.0.1:${port}`;
  const control = { "x-redoma-control": token };
  let front: http.Server | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    process.removeListener("exit", killOnExit);
    front?.close();
    front?.closeAllConnections();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    release();
    rmSync(folder, { recursive: true, force: true });
  };

  const outcome = await Promise.race([
    becameReady.then(() => "ready" as const),
    exited.then(() => "exited" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 90_000).unref()),
  ]);
  if (outcome !== "ready") {
    await stop();
    throw new StartError(outcome === "timeout" ? "The local runtime did not start within 90 seconds." : startFailure(output));
  }

  if (options.listen) {
    try {
      front = await frontDoor(port, options.listen.port, options.listen.host);
    } catch (error) {
      await stop();
      throw error;
    }
  }

  return {
    origin,
    token,
    output,
    exited,
    stop,
    async status(): Promise<AppStatus> {
      const response = await fetch(`${origin}/__redoma/status`, { headers: control });
      return (await response.json()) as AppStatus;
    },
    async tick(time = new Date()): Promise<{ ran: number; errors: string[] }> {
      const response = await fetch(`${origin}/__redoma/cron`, {
        method: "POST",
        headers: control,
        body: JSON.stringify({ scope: "", time: time.getTime() }),
      });
      return (await response.json()) as { ran: number; errors: string[] };
    },
  };
}

/** Call `runtime.tick()` at the start of every minute, like Cloudflare's Cron Trigger does. */
export function startTicking(runtime: Runtime, onError: (message: string) => void): () => void {
  let timer: NodeJS.Timeout;
  const schedule = (): void => {
    const now = Date.now();
    timer = setTimeout(async () => {
      schedule();
      try {
        await runtime.tick(new Date(Math.floor(Date.now() / 60_000) * 60_000));
      } catch (error) {
        onError(`cron tick failed: ${error instanceof Error ? error.message : error}`);
      }
    }, 60_000 - (now % 60_000) + 20);
  };
  schedule();
  return () => clearTimeout(timer);
}

/** Is something already accepting connections on this port? */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (used: boolean): void => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(400, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** First port in [from, to] nobody is using, or undefined. */
export async function firstFreePort(from: number, to: number): Promise<number | undefined> {
  for (let port = from; port <= to; port++) {
    if (!(await portInUse(port)) && (await canListen(port))) return port;
  }
  return undefined;
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Two runtimes on the same data would corrupt it: one owner per data directory. */
function lock(dataDir: string, mode: string): () => void {
  const path = join(dataDir, ".lock");
  try {
    const [pid = "", owner = "another process"] = readFileSync(path, "utf8").split(" ");
    if (Number(pid) !== process.pid && alive(Number(pid))) {
      throw new StartError(
        `The app's data in .data/ is in use by ${owner === "service" ? "the Linux service" : "another `npm run " + owner + "`"} (process ${pid}). ` +
          "Stop it first: two copies writing the same data would corrupt it.",
      );
    }
  } catch (error) {
    if (error instanceof StartError) throw error;
  }
  writeFileSync(path, `${process.pid} ${mode}`);
  return () => rmSync(path, { force: true });
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Turn Wrangler's lines into what an app developer wants to read; undefined hides the line. */
function presentable(line: string): string | undefined {
  const text = line.replace(/^\[wrangler:(info|warn|error)\]\s*/, "").trimEnd();
  if (text.trim() === "" || text.includes("/__redoma/") || text.startsWith("Using secrets defined in")) return undefined;
  if (text.startsWith("⎔ Local server updated")) return "↻ Reloaded";
  if (/^(⎔|▲ \[WARNING\] Proxy environment)/.test(text)) return undefined;
  return text.replace(/(\.\.\/)+(sandbox|deps|engine)\//g, "$2/");
}

/** The useful part of Wrangler's output when it never became ready. */
function startFailure(output: string[]): string {
  const errors: string[] = [];
  let taking = false;
  for (const line of output) {
    if (/^✘ \[ERROR\]/.test(line)) taking = true;
    else if (/^(▲ \[WARNING\]|🪵|If you think this is a bug)/.test(line)) taking = false;
    if (taking && line.trim() !== "" && !/^\s+at /.test(line)) errors.push(line.replace(/^✘ \[ERROR\]\s*/, "").replace(/(\.\.\/)+(sandbox|deps|engine)\//g, "$2/"));
  }
  const detail = (errors.length > 0 ? errors : output.filter((line) => line.trim() !== "").slice(-8)).join("\n  ");
  return `The app could not be built or started:\n  ${detail}`;
}

// ---------------------------------------------------------------------------
// Front door
// ---------------------------------------------------------------------------

const HIDDEN = /^\/(cdn-cgi|__redoma|__cf_local)(\/|$|\?)/i;
const INTERNAL_HEADERS = new Set(["x-redoma-control", "x-redoma-scope", "cf-connecting-ip"]);

function frontDoor(target: number, port: number, host?: string): Promise<http.Server> {
  const agent = new http.Agent({ keepAlive: true });

  /** Headers for the Worker: the client's own, minus ours, plus who is really calling. */
  const forwarded = (request: http.IncomingMessage): Record<string, string | string[]> => {
    const headers: Record<string, string | string[]> = {};
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i]!;
      const value = request.rawHeaders[i + 1]!;
      if (INTERNAL_HEADERS.has(name.toLowerCase())) continue;
      const existing = headers[name];
      headers[name] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
    }
    const peer = (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const local = peer === "127.0.0.1" || peer === "::1";
    // A reverse proxy on this machine (Caddy, nginx) is trusted to say who the client is.
    const via = local ? String(request.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim() : undefined;
    headers["CF-Connecting-IP"] = via || peer;
    if (!local) {
      delete headers["x-forwarded-proto"];
      delete headers["X-Forwarded-Proto"];
    }
    return headers;
  };

  const server = http.createServer((request, response) => {
    if (HIDDEN.test(request.url ?? "/")) {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
      return;
    }
    const upstream = http.request(
      { host: "127.0.0.1", port: target, method: request.method, path: request.url, headers: forwarded(request), agent },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "content-type": "text/plain" }).end("The app is restarting. Try again in a moment.\n");
    });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });

  // WebSocket and other upgrades: hand the raw connection over.
  server.on("upgrade", (request, socket, head) => {
    if (HIDDEN.test(request.url ?? "/")) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(target, "127.0.0.1", () => {
      const headers = forwarded(request);
      const lines = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`));
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(new StartError(error.code === "EADDRINUSE" ? `Port ${port} is already in use.` : `Cannot listen on port ${port}: ${error.message}`));
    });
    server.listen(port, host, () => resolve(server));
  });
}
