# Contributing to Moljud Pages

Thank you for wanting to help. Issues, ideas and pull requests are all welcome, and you do not need to be an expert to send one.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Found a security problem?** Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Found a bug or have an idea?** Search the [issues](https://github.com/newmoljud/moljud-pages/issues) first, then open a new one with the template.
- **Planning a larger change?** Open an issue to talk about it before writing code. It saves work for everyone.

## Project limits

Moljud Pages is small on purpose. A change is unlikely to be accepted if it breaks one of these:

- **One SQLite database is the only storage.** No buckets, object storage or second database.
- **Sites are read-only content in `sites/`.** The app never writes to them.
- **No runtime dependencies.** The app uses only what `deps/` offers and Web standard APIs.
- **English** for the interface, the code and the documentation.

## How the repository is organised

| Folder | What it is | Change it here? |
|---|---|---|
| `sandbox/` | The app: routes, pages, API, template engine and tests. | **Yes.** Almost every contribution lives here. |
| `sites/` | Example content and the white-label folder `sites/label/`. | Yes, for the example and the default brand. |
| `deps/` | The contract between the app and the engine: types and documentation only. | No. |
| `engine/`, `scripts/` | The machinery from [Redoma](https://github.com/MateusMoutinhoOrg/Redoma) that runs the app. | No. Propose engine changes upstream, in Redoma. |

`wrangler.jsonc` is generated. When `npm run test` changes it, commit it together with your change.

## Setting up

You need [Node.js](https://nodejs.org) 22.18 or newer.

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` prints the local address. To sign in locally you need the three secrets described in the [README](README.md#quick-start); use made-up values on your machine and never commit them.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Keep the change small and focused: one subject per pull request.
3. Add or update a test in `sandbox/main.test.ts` for any behaviour you change.
4. Run the checks:

   ```bash
   npm run test
   ```

5. Update the README or the comments when behaviour changes, and add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
6. Open the pull request and fill in the template.

### Style

- TypeScript, strict. Follow the style of the file you are editing.
- Every value that reaches a page goes through the `html` helper, and every value that reaches SQL goes as a `?` parameter. Never build either by joining strings.
- Database schema changes are **appended** to `MIGRATIONS` in `sandbox/core.ts`. A published statement is never edited or removed.
- Write commit messages in English, in the imperative: "Add reader search", not "added" or "att".

### What must never be in a commit

- Secrets, passwords, API keys, `.dev.vars` or `.env` files.
- The `.data/` folder (your local database).
- Real private sites or personal data. Use made-up content in examples and tests.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE). The Moljud name and logo are trademarks of Moljud and are not covered by it.
