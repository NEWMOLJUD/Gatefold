// npm run test
// Type-check everything, run the restrict gates if the lock is on, then run
// the sandbox tests against the local runtime. The one command to run before
// calling work done.
import { listTestFiles } from "../engine/tools/analyze.ts";
import { check } from "../engine/tools/checks.ts";
import { fail, failWithProblems, ok, preflight, say } from "../engine/tools/cli.ts";
import { StartError } from "../engine/tools/runtime.ts";
import { runTests } from "../engine/tools/testing.ts";

preflight();

const checked = await check({ types: true, tools: true, config: "write" });
if (checked.problems.length > 0) {
  failWithProblems(
    `${checked.problems.length} problem${checked.problems.length === 1 ? "" : "s"} found before running the tests:`,
    checked.problems,
    "Fix them and run `npm run test` again.",
  );
}

const files = listTestFiles();
let report;
try {
  report = await runTests(files);
} catch (error) {
  if (error instanceof StartError) fail(error.message, "Fix the error above and run `npm run test` again.");
  throw error;
}

if (report.startError) {
  fail(`The app does not start: ${report.startError}`, "Fix sandbox/main.ts (or the file it names) and run `npm run test` again.");
}

if (report.failures.length > 0) {
  process.stderr.write(`✗ ${report.failures.length} of ${report.failures.length + report.passed} tests failed:\n`);
  for (const failure of report.failures) {
    process.stderr.write(`\n  ${failure.file}${failure.line ? `:${failure.line}` : ""}  "${failure.name}"\n`);
    for (const line of failure.message.split("\n")) process.stderr.write(`    ${line}\n`);
    if (failure.log.length > 0) {
      process.stderr.write("    The app logged:\n");
      for (const line of failure.log) process.stderr.write(`      ${line.trim()}\n`);
    }
  }
  process.stderr.write("\n→ Fix the failing tests (or the code they cover) and run `npm run test` again.\n");
  process.exit(1);
}

for (const note of checked.notes) say(`! ${note}`);
const tests = report.passed === 0 ? "no tests yet, the app starts" : `${report.passed} test${report.passed === 1 ? "" : "s"} passed`;
ok(`All good: types checked${checked.restricted ? ", restrict gates passed" : ""}, ${tests}.`);
process.exit(0);
