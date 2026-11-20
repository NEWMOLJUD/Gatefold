// npm run deploy:check
// Everything `npm run deploy` does except the upload: type check, restrict
// gates, bundle, configuration. Needs no Cloudflare login.
import { deploy } from "../engine/tools/cloudflare.ts";
import { preflight } from "../engine/tools/cli.ts";

preflight();
await deploy({ dryRun: true });
