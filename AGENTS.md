# Redoma

A TypeScript web server for Cloudflare Workers and Linux. The app lives in a sandbox and reaches the outside world only through `deps`. The user may not be a programmer: keep changes small and explain them plainly.

## Map

- `sandbox/` is the app: `main.ts` (entry point), any modules you add, `public/` (static frontend), `*.test.ts` (tests).
- `deps/` is the contract: types and documentation for everything the app can use. No logic.
- `engine/` implements `deps/` and runs the app. `scripts/` holds the `npm run` commands.

## Reading order

1. `deps/index.ts`, then the `deps/` file for the capability you need. Its comments are the API documentation.
2. `sandbox/`, to see what the app already does.
3. `README.md`, only for questions about commands.

Open a file in `engine/` only when those did not answer the question, and then only the one file you need. The engine is implementation detail: reading it spends tokens and changes nothing about what the sandbox can do.

## Where to write

Only in `sandbox/`, unless the user explicitly asks to change the template itself. `wrangler.jsonc` is generated: when `npm run test` updates it, commit it too.

## Secrets: always ask, never assume

Never set, change, remove or read a secret value, and never ask the user to paste one into the chat. When a task involves a secret, stop before writing code that depends on it:

1. Explain what the secret is for and get explicit approval.
2. Ask how they publish: Git connected in the Cloudflare dashboard, or `npm run deploy` from a terminal. Many users have no CLI configured, and the steps differ.
3. Write the code with `deps.secrets.get("NAME")`, then give them the steps: `npm run secret set NAME` on their machine (they type the value at a hidden prompt), and, if they publish through Git, also the dashboard: Workers & Pages → the Worker → Settings → Variables and Secrets → Add, type "Secret".

Do not run or suggest a CLI login on your own. Why: beginners get lost when keys appear or change without their knowledge, and an app that works locally but fails once published, because the secret exists only on their machine, is the most common way that happens.

## Finishing

- Run `npm run test` before reporting work as done.
- Deploy only when asked. For Git-connected users a push is a deploy.
- Never run `npm run update`. It is the user's call.

## Restrict mode

If a gate blocks something (an import, a global, an edit outside `sandbox/`), tell the user what was blocked and why. Do not work around it.
