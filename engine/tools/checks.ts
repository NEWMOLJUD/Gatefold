// The checks every path to a running app goes through. `npm run test`,
// `npm run deploy`, `npm run dev`, the Wrangler build step and the Linux
// watcher all call this, with different strictness.
import { analyze } from "./analyze.ts";
import { type Problem, rel, WRANGLER_CONFIG } from "./cli.ts";
import { type Features, syncDeployConfig } from "./config.ts";
import { isRestricted, projectName } from "./project.ts";

export interface CheckOptions {
  /** Report type errors in sandbox/, deps/ and the Worker side of the engine. */
  types: boolean;
  /** Also type-check the Node side of the engine and scripts/. */
  tools?: boolean;
  /**
   * What to do when wrangler.jsonc no longer matches the sandbox:
   * "write" updates it, "require" reports a problem, "ignore" does nothing.
   */
  config: "write" | "require" | "ignore";
}

export interface CheckResult {
  problems: Problem[];
  /** Things the user should know even when everything passed. */
  notes: string[];
  restricted: boolean;
  features: Features;
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const restricted = isRestricted();
  const { problems, uses } = await analyze({ types: options.types, tools: options.tools ?? false, restricted });
  const notes: string[] = [];

  if (options.config !== "ignore") {
    const sync = syncDeployConfig(projectName(), uses, options.config === "write");
    if (sync.stale && options.config === "write") {
      notes.push(`wrangler.jsonc was updated (${sync.change}). Commit it with your changes.`);
    } else if (sync.stale) {
      problems.push({
        file: rel(WRANGLER_CONFIG),
        line: 0,
        column: 0,
        message:
          `out of date (${sync.change}): the app changed what it uses since this file was generated. ` +
          "On your computer run `npm run test`, commit the updated wrangler.jsonc and publish again.",
      });
    }
  }
  return { problems, notes, restricted, features: uses };
}
