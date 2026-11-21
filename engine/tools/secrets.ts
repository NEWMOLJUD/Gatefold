// The secrets file for this machine: .dev.vars in the project root, git-ignored,
// readable only by its owner. `npm run dev`, the tests' runtime and the Linux
// service read it. Values are written in a form the runtime reads back
// byte for byte.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { SECRETS_FILE } from "./cli.ts";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Why a name cannot be used, or undefined when it is fine. */
export function secretNameProblem(name: string | undefined): string | undefined {
  if (!name) return "give the secret a name, for example: npm run secret set RESEND_API_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `"${name}" is not a valid name: use letters, digits and "_" (for example RESEND_API_KEY)`;
  if (name.toUpperCase().startsWith("REDOMA_")) return "names starting with REDOMA_ are reserved for the engine";
  return undefined;
}

function lines(): string[] {
  return existsSync(SECRETS_FILE) ? readFileSync(SECRETS_FILE, "utf8").split("\n") : [];
}

/** Names only. Values never leave the file through this module. */
export function localSecretNames(): string[] {
  const names = new Set<string>();
  for (const line of lines()) {
    const name = LINE.exec(line)?.[1];
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** Quote a value so that the runtime's parser returns it unchanged. */
function encode(value: string): string | undefined {
  if (/[\r\n]/.test(value)) return undefined;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  return undefined;
}

/** Add or replace one secret. Returns false when the value cannot be stored safely. */
export function setLocalSecret(name: string, value: string): boolean {
  const encoded = encode(value);
  if (encoded === undefined) return false;
  const kept = lines().filter((line) => LINE.exec(line)?.[1] !== name);
  while (kept.length > 0 && kept.at(-1)!.trim() === "") kept.pop();
  save([...kept, `${name}=${encoded}`]);
  return true;
}

/** Returns false when there was nothing to remove. */
export function removeLocalSecret(name: string): boolean {
  const all = lines();
  const kept = all.filter((line) => LINE.exec(line)?.[1] !== name);
  if (kept.length === all.length) return false;
  save(kept);
  return true;
}

function save(content: string[]): void {
  while (content.length > 0 && content.at(-1)!.trim() === "") content.pop();
  writeFileSync(SECRETS_FILE, content.length > 0 ? `${content.join("\n")}\n` : "", { mode: 0o600 });
  chmodSync(SECRETS_FILE, 0o600);
}
