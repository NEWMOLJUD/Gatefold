// npm run deploy
// Check the app, publish it to Cloudflare and print its address. Walks through
// the Cloudflare login when needed. For unattended use (CI), set
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
import { deploy } from "../engine/tools/cloudflare.ts";
import { preflight } from "../engine/tools/cli.ts";

preflight();
await deploy({ dryRun: false });
