// The gate in front of every deployment. Wrangler runs this file as its build
// step (wrangler.jsonc → build.command), so it runs for `npm run deploy`, for
// a plain `npx wrangler deploy`, and on Cloudflare's builders when the repo is
// connected through Git. Nothing has to be logged in or configured for it.
//
// It also runs after `npm install` on Cloudflare's builders ("install" mode,
// see package.json → postinstall): a second net in case a builder skips
// Wrangler's build step. On any other machine that mode does nothing.
//
// Modes: (none) = full deploy check; "install" = the same, on Cloudflare only;
// "gates" = restrict gates only (the Linux watcher, before it restarts the app).
import { check } from "./tools/checks.ts";
import { formatProblem } from "./tools/cli.ts";

const mode = process.argv[2] ?? "";
if (mode === "install" && !process.env.WORKERS_CI) process.exit(0);

try {
  const result = await check(mode === "gates" ? { types: false, config: "ignore" } : { types: true, config: "require" });
  if (result.problems.length > 0) {
    console.error(`\nNot deploying: ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"} found.\n`);
    for (const problem of result.problems) console.error(`  ${formatProblem(problem)}`);
    console.error("\nFix them (run `npm run test` on your computer to see the same list), then publish again.\n");
    process.exit(1);
  }
} catch (error) {
  console.error(`\nNot deploying: the checks could not run. ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}
