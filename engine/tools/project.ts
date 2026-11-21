// The project's identity and settings live in package.json: the `name`, and a
// `redoma` block with the template URL and the restrict switch.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./cli.ts";

export const PACKAGE_JSON = join(ROOT, "package.json");
/** The name the template ships with; `npm run rename` replaces it. */
export const TEMPLATE_NAME = "redoma";

export interface PackageJson {
  name: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  redoma?: { template?: string; restrict?: boolean; preflight?: string };
  [key: string]: unknown;
}

export function readPackage(path = PACKAGE_JSON): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

export function writePackage(pkg: PackageJson, path = PACKAGE_JSON): void {
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function projectName(): string {
  return readPackage().name;
}

export function isRestricted(): boolean {
  return readPackage().redoma?.restrict === true;
}

export function templateUrl(): string | undefined {
  return readPackage().redoma?.template;
}

/**
 * A project name is also the Worker name, the systemd unit name and the prefix
 * of the R2 bucket name, so it must satisfy all of them.
 */
export function nameProblem(name: string): string | undefined {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return "use lowercase letters, digits and dashes only, starting and ending with a letter or digit (for example: my-shop)";
  }
  if (name.length > 50) return "use at most 50 characters";
  return undefined;
}
