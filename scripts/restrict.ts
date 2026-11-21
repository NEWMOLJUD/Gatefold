// npm run restrict on | off | status
//
// on:     lock the app into sandbox/. From then on `dev`, `test`, `deploy` and
//         the Linux service refuse sandbox code that imports anything but
//         sandbox/ and deps/ or touches a global outside deps/globals.ts, and
//         Claude Code is denied edits outside sandbox/.
// off:    unlock. Asks for confirmation at a terminal, so an agent cannot do it.
// status: is the lock on, and did any protected file change since?
import { check } from "../engine/tools/checks.ts";
import { fail, failWithProblems, ok, preflight, say } from "../engine/tools/cli.ts";
import { isRestricted } from "../engine/tools/project.ts";
import { confirmByTyping, requireTerminal } from "../engine/tools/prompt.ts";
import { changedSinceLock, lock, missingAgentRules, unlock } from "../engine/tools/restrict.ts";

preflight();
const action = process.argv[2];

if (action === "on") {
  if (isRestricted()) {
    say("Restrict mode is already on. (To re-lock after a deliberate change, turn it off and on again.)");
    process.exit(0);
  }
  lock();
  const checked = await check({ types: false, config: "ignore" });
  if (checked.problems.length > 0) {
    unlock();
    failWithProblems(
      "Restrict mode was not turned on: the sandbox already breaks its rules.",
      checked.problems,
      "Change these lines (or remove the packages they need) and run `npm run restrict on` again.",
    );
  }
  ok("Restrict mode is on: the app is locked into sandbox/. Commit package.json, .claude/settings.json and engine/restrict.lock.json.");
} else if (action === "off") {
  if (!isRestricted()) {
    say("Restrict mode is already off.");
    process.exit(0);
  }
  requireTerminal("Turning restrict mode off", "the lock exists so that only you can remove it.");
  if (!(await confirmByTyping("Turn restrict mode off? Agents will again be able to import packages and edit files outside sandbox/.", "off"))) {
    fail("Cancelled. Restrict mode is still on.");
  }
  unlock();
  ok("Restrict mode is off. Commit the change to package.json (and the removed lock files).");
} else if (action === "status") {
  if (!isRestricted()) {
    say("Restrict mode is off: agents are asked to stay in sandbox/, nothing enforces it. Turn it on with `npm run restrict on`.");
    process.exit(0);
  }
  const changed = changedSinceLock();
  const missing = missingAgentRules();
  const issues: string[] = [];
  if (changed === undefined) issues.push("engine/restrict.lock.json is missing, so changes to protected files cannot be detected");
  else for (const file of changed) issues.push(`protected file ${file} since the lock was turned on`);
  if (missing.length > 0) issues.push(`.claude/settings.json no longer has ${missing.length} of the deny rules`);
  if (issues.length === 0) {
    ok("Restrict mode is on and every protected file is as it was when you locked it.");
  } else {
    process.stderr.write("! Restrict mode is on, but something changed underneath it:\n");
    for (const issue of issues) process.stderr.write(`  ${issue}\n`);
    process.stderr.write("→ Review these with `git diff`. If the changes are yours, re-lock: `npm run restrict off`, then `npm run restrict on`.\n");
    process.exit(1);
  }
} else {
  fail(action ? `Unknown action "${action}".` : "Tell me what to do with restrict mode.", "Use one of: npm run restrict on   |   npm run restrict off   |   npm run restrict status");
}
