// The watcher: what the optional watcher service executes.
//   node engine/watcher.ts SECONDS
// Every SECONDS it asks the repository's remote for new commits. When there
// are some it pulls them (fast-forward only), installs dependencies if they
// changed, checks the restrict gates with the new code and restarts the app.
// A commit that fails the gates is rolled back and the app keeps running the
// previous one. It never touches a working tree that has local changes.
import { ROOT, run } from "./tools/cli.ts";
import { projectName } from "./tools/project.ts";
import { restartService } from "./tools/service.ts";

const seconds = Number(process.argv[2]);
if (!Number.isInteger(seconds) || seconds < 5) {
  console.error("Usage: node engine/watcher.ts SECONDS   (5 or more)");
  process.exit(2);
}

const git = (...args: string[]) => run("git", args, { cwd: ROOT });
const text = (result: { stdout: string; stderr: string }): string => (result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ");
let lastProblem = "";
const report = (problem: string): void => {
  // Say each problem once, not every interval.
  if (problem !== lastProblem) console.error(problem);
  lastProblem = problem;
};

console.log(`Watching ${git("remote", "get-url", "origin").stdout.trim() || "the remote"} every ${seconds} seconds.`);

for (;;) {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

  const fetched = git("fetch", "--quiet");
  if (fetched.code !== 0) {
    report(`Cannot reach the remote: ${text(fetched)}`);
    continue;
  }
  const behind = git("rev-list", "--count", "HEAD..@{u}");
  if (behind.code !== 0) {
    report("This branch does not follow a remote branch. Run once: git branch --set-upstream-to=origin/<branch>");
    continue;
  }
  if (behind.stdout.trim() === "0") {
    lastProblem = "";
    continue;
  }
  if (git("status", "--porcelain", "--untracked-files=no").stdout.trim() !== "") {
    report("New commits are waiting, but files here were changed by hand. Commit or discard those changes; nothing was pulled.");
    continue;
  }

  const previous = git("rev-parse", "HEAD").stdout.trim();
  const merged = git("merge", "--ff-only", "--quiet", "@{u}");
  if (merged.code !== 0) {
    report(`Cannot fast-forward to the new commits: ${text(merged)}`);
    continue;
  }
  const current = git("rev-parse", "--short", "HEAD").stdout.trim();
  const needsInstall = git("diff", "--name-only", previous, "HEAD", "--", "package.json", "package-lock.json").stdout.trim() !== "";
  const rollBack = (why: string): void => {
    git("reset", "--hard", "--quiet", previous);
    if (needsInstall) run("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT });
    report(`Commit ${current} was not applied: ${why} The app keeps running the previous version.`);
  };

  if (needsInstall) {
    const installed = run("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT });
    if (installed.code !== 0) {
      rollBack(`npm install failed (${text(installed)}).`);
      continue;
    }
  }
  // Run the gates with the code that was just pulled, in a fresh process.
  const gates = run(process.execPath, ["engine/build.ts", "gates"], { cwd: ROOT });
  if (gates.code !== 0) {
    rollBack(`it breaks restrict mode.\n${(gates.stderr || gates.stdout).trim()}\n`);
    continue;
  }
  if (!restartService(projectName())) {
    report(`Pulled ${current}, but the service could not be restarted. Run \`npm run service:status\`.`);
    continue;
  }
  console.log(`Updated to ${current} and restarted the app.`);
  // The watcher's own code may have changed: exit and let systemd start the new one.
  process.exit(0);
}
