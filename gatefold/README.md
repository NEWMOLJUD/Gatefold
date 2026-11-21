# gatefold/

The commands that keep an installation of Gatefold up to date. This folder is part of the app: an update replaces it, together with `sandbox/`.

| Command | What it does |
|---|---|
| `npm run update` | Brings the installation to the newest released version: the machinery (`engine/`, `deps/`, `scripts/`) and the app (`sandbox/`, this folder, the documents at the root), from one download of the Gatefold repository. `npm run update -- --to v1.2.3` picks a version. |
| `npm run repair` | Puts the files of the version already installed back as they shipped. `npm run repair -- --label` also puts `sites/label/app.css` back. |
| `npm run doctor` | Says what is wrong or worth knowing about this installation. Changes nothing. `-- --online` also looks for a newer version. |
| `node gatefold/update.ts status` | Which version is installed, which is the newest, and which files differ from the release. |
| `npm run update:engine` | For maintainers of Gatefold: the machinery's own update, straight from Redoma. Installations do not need it. |

## What an update touches, and what it never does

- **Replaced:** `engine/`, `deps/`, `scripts/`, `sandbox/`, `gatefold/`, and the root files the machinery owns.
- **Kept if you rewrote them:** the documents at the root (`README.md`, `CHANGELOG.md`, `SECURITY.md` and the others). Untouched ones are replaced.
- **Never touched:** `sites/` (your sources, your name, logo and colours), your secrets, your data.
- **The one exception in `sites/`:** `sites/label/app.css` holds every rule the pages use, so a new version needs its new rules there. An untouched `app.css` is replaced. One you changed is merged with the new rules. When the merge does not fit, yours is left alone and the new stylesheet is put beside it as `app.css.new`, for you to bring the rules in by hand.

An update refuses to start with uncommitted changes, shows the versions, the changelog and every file it will change, and asks before doing anything. It ends by running the same checks as `npm run test`.

## Undoing

Before you commit, the update prints the one command that undoes it (`git reset --hard … && git clean -fd && npm install`).

**After the new version has run on your real data, going back to the old code is not enough.** A new version may add tables and columns when it first starts, and the old code does not know them. Back up before publishing an update.

## Where versions come from

From the address in `package.json`, under `"gatefold": { "source": "…" }`. Versions are the tags named `vX.Y.Z` of that repository. For a private repository, git must be able to reach it by itself (an SSH key or a credential helper): do not put a password in the address.

`gatefold/manifest.json` records the version installed and a fingerprint of every file of the app, which is how these commands know what you changed. `gatefold/defaults/` keeps the stylesheets as they shipped, which is what your `app.css` is merged against.

## Installations made before this folder existed

They have no `gatefold/` to run. Bring it in once, by hand, and let it do the rest:

```bash
git clone --depth 1 --branch vX.Y.Z <address of the Gatefold repository> /tmp/gatefold
```

```bash
cp -r /tmp/gatefold/gatefold .
```

```bash
git add gatefold && git commit -m "Add the Gatefold updater"
```

```bash
node gatefold/update.ts repair
```

## Releasing (maintainers)

```bash
node gatefold/release.ts 1.2.3
```

It writes the version into `package.json`, `sandbox/version.ts` and `CHANGELOG.md`, copies the stylesheets into `gatefold/defaults/`, and rebuilds the manifest. It commits and tags nothing: it ends by listing the commands. `node gatefold/update.ts check --release` verifies that everything agrees before the tag.
