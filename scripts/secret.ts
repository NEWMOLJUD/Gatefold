// npm run secret set NAME | npm run secret list | npm run secret remove NAME
//
// A secret can live in three places: this machine (.dev.vars, used by
// `npm run dev` and the Linux service), the app published on Cloudflare, and
// any other server that runs the app. Each command says which places it reached.
// Values are typed at a hidden prompt: never an argument, never piped in.
import { dashboardSecretSteps, deleteRemoteSecret, loggedIn, putRemoteSecret, remoteSecrets } from "../engine/tools/cloudflare.ts";
import { fail, ok, preflight, say } from "../engine/tools/cli.ts";
import { projectName } from "../engine/tools/project.ts";
import { askHidden, confirmByTyping, requireTerminal } from "../engine/tools/prompt.ts";
import { localSecretNames, removeLocalSecret, secretNameProblem, setLocalSecret } from "../engine/tools/secrets.ts";

preflight();
const [action, name] = process.argv.slice(2);
const usage = "Use one of: npm run secret set NAME   |   npm run secret list   |   npm run secret remove NAME";

if (action === "set") {
  const problem = secretNameProblem(name);
  if (problem) fail(`Cannot set the secret: ${problem}.`, usage);
  requireTerminal("Setting a secret", "the value is typed at a hidden prompt so it never appears in a command, a file you share or a chat.");
  const value = await askHidden(`Value for ${name} (hidden; paste or type it, then press Enter): `);
  if (value === "") fail("No value entered. Nothing was changed.", `Run \`npm run secret set ${name}\` again and enter the value.`);
  if (!setLocalSecret(name!, value)) {
    fail("That value mixes all three kinds of quotes with backslashes and cannot be stored safely.", "Generate a simpler value (most providers let you create a new key) and try again.");
  }
  ok(`Saved ${name} on this machine (.dev.vars). Restart \`npm run dev\` or the service to use it.`);
  reportCloudflare(name!, value);
  say("  Another server running this app needs it too: run this same command there.");
} else if (action === "list") {
  const local = localSecretNames();
  const online = loggedIn() ? remoteSecrets() : undefined;
  const remote = online?.state === "ok" ? online.names : [];
  const all = [...new Set([...local, ...remote])].sort();
  if (all.length === 0) say("No secrets yet. Add one with: npm run secret set NAME");
  for (const item of all) {
    const here = local.includes(item) ? "this machine" : "";
    const there = remote.includes(item) ? "Cloudflare" : "";
    say(`${item.padEnd(28)} ${[here, there].filter(Boolean).join(" + ")}`);
  }
  if (!online) say("(Cloudflare not checked: this terminal is not logged in. The dashboard shows them under Workers & Pages → " + projectName() + " → Settings.)");
  else if (online.state === "not-deployed") say("(The app is not on Cloudflare yet, so it has no secrets there.)");
  else if (online.state === "error") say(`(Could not read the secrets on Cloudflare: ${online.detail})`);
} else if (action === "remove") {
  const problem = secretNameProblem(name);
  if (problem) fail(`Cannot remove the secret: ${problem}.`, usage);
  requireTerminal("Removing a secret", "deleting a key can break the running app, so a person has to confirm it.");
  if (!(await confirmByTyping(`Remove the secret ${name} from this machine and, if this terminal is logged in, from Cloudflare?`, "remove"))) {
    fail("Cancelled. Nothing was changed.");
  }
  const removedHere = removeLocalSecret(name!);
  say(removedHere ? `✓ Removed ${name} from this machine (.dev.vars).` : `  ${name} was not set on this machine.`);
  if (!loggedIn()) {
    say(`! Not removed from Cloudflare: this terminal is not logged in. If it is set there, delete it by hand: ${dashboardSecretSteps(name!).replace(/ → Add.*$/, ` → ${name} → Delete → Deploy`)}`);
  } else {
    const online = remoteSecrets();
    if (online.state === "ok" && online.names.includes(name!)) {
      const result = deleteRemoteSecret(name!);
      say(result.ok ? `✓ Removed ${name} from Cloudflare.` : `! Could not remove ${name} from Cloudflare: ${result.detail}`);
    } else {
      say(`  ${name} was not set on Cloudflare.`);
    }
  }
} else {
  fail(action ? `Unknown action "${action}".` : "Tell me what to do with secrets.", usage);
}

function reportCloudflare(secret: string, value: string): void {
  if (!loggedIn()) {
    say("! Not sent to Cloudflare: this terminal is not logged in there. That is normal if you publish through Git.");
    say(`  To use it in the published app, add it by hand: ${dashboardSecretSteps(secret)}`);
    return;
  }
  const online = remoteSecrets();
  if (online.state === "not-deployed") {
    say(`! Not sent to Cloudflare: the app is not published yet. After the first \`npm run deploy\`, run \`npm run secret set ${secret}\` again.`);
    return;
  }
  const result = putRemoteSecret(secret, value);
  if (result.ok) ok(`Sent ${secret} to Cloudflare (Worker "${projectName()}"). It is live now.`);
  else say(`! Could not send ${secret} to Cloudflare: ${result.detail}\n  Add it by hand instead: ${dashboardSecretSteps(secret)}`);
}
