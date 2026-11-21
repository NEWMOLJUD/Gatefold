// Giving the project its name. The name is stored in package.json and repeated
// in the Worker config, package-lock.json and the headings of README.md and
// AGENTS.md. `npm run rename` changes it; `npm run update` re-applies it to
// the fresh copies of those files.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "./analyze.ts";
import { ROOT } from "./cli.ts";
import { syncDeployConfig } from "./config.ts";
import { TEMPLATE_NAME, readPackage, writePackage } from "./project.ts";

const HEADER_START = "<!-- redoma:header -->";
const HEADER_END = "<!-- /redoma:header -->";
const TEMPLATE_HOME = "https://github.com/MateusMoutinhoOrg/Redoma";

/** Write `name` everywhere the project is named. Safe to run again with the same name. */
export async function applyName(name: string): Promise<void> {
  const pkg = readPackage();
  if (pkg.name !== name) {
    pkg.name = name;
    writePackage(pkg);
  }

  const lockPath = join(ROOT, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { name?: string; packages?: Record<string, { name?: string }> };
    if (lock.name !== name || lock.packages?.[""]?.name !== name) {
      lock.name = name;
      if (lock.packages?.[""]) lock.packages[""].name = name;
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }
  }

  const { uses } = await analyze({ types: false, tools: false, restricted: false });
  syncDeployConfig(name, uses, true);

  const readme = join(ROOT, "README.md");
  if (existsSync(readme) && name !== TEMPLATE_NAME) {
    const text = readFileSync(readme, "utf8");
    const start = text.indexOf(HEADER_START);
    const end = text.indexOf(HEADER_END);
    if (start >= 0 && end > start) {
      // The template's own masthead makes no sense on someone else's project: replace it with a plain title.
      const header = `${HEADER_START}\n# ${name}\n\nBuilt with [Redoma](${TEMPLATE_HOME}), a TypeScript template for Cloudflare Workers and Linux that keeps the app in a sandbox. This page is the manual for the commands.\n${HEADER_END}`;
      writeFileSync(readme, text.slice(0, start) + header + text.slice(end + HEADER_END.length));
    }
  }

  const agents = join(ROOT, "AGENTS.md");
  if (existsSync(agents)) {
    const text = readFileSync(agents, "utf8");
    const title = name === TEMPLATE_NAME ? "# Redoma" : `# ${name}`;
    if (text.startsWith("# ")) writeFileSync(agents, title + text.slice(text.indexOf("\n")));
  }
}
