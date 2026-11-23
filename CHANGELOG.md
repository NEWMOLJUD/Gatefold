# Changelog

Notable changes to Gatefold are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-11-23

### Upgrade notes

- **Sources are now uploaded, and `sites/sources/` is no longer read.** After updating, every source keeps its visibility and its permissions but **has no files, and answers "not found", until its folder is uploaded again**: open each one under **Sources** and upload its folder (or use the API, see "Publish from a script" in the README). Then delete `sites/sources/` from the repository. Do this right after publishing the update, when few readers are around.
- **On Cloudflare, R2 must be turned on before publishing this version** (dashboard → R2 → finish the one-time setup). The app now stores files there, and the publication fails without it. `wrangler.jsonc` gains the bucket.
- `GET /api/admin/sources` no longer lists `props`, `render`, `origin`, `problems`, `missing` and `ignored`; each item now has `files` and `bytes`. `GET /api/admin/sources/:alias` still answers the settings, without `missing`. `DELETE /api/admin/sources/:alias` now removes the source **with all its files**, whenever it is called.
- The source pages use four new rules in `sites/label/app.css` (`td form.inline`, `progress`, `.upload-log` and `.upload-log[hidden]`). An installation with its own `app.css` should copy them.
- **`npm run update` now updates Gatefold itself**, app and machinery together, from the Gatefold repository. The machinery's own update (straight from Redoma) is `npm run update:engine`, and installations do not need it. An installation made before this version has no `gatefold/` folder: see "Installations made before this folder existed" in `gatefold/README.md`.
- **The root password must now have at least 32 characters.** With a shorter `GATEFOLD_ROOT_PASSWORD`, `/root/setup` answers that root access is off until a longer one is set where the app runs. Nothing else stops working.
- **An administrator no longer sets another administrator's password.** `PUT /api/admin/admins/:id` with `password` answers 403 unless it is one's own account. Everyone changes their own password under **Your account**; a lost administrator password is set by root (`PUT /api/root/admins/:id`, or **Set password** on `/root/setup`).
- **The last administrator who can sign in can no longer be removed** by an administrator (409). Root still can.
- API keys are listed with three more fields (`name`, `expires_at`, `last_used_at`). The key pages use no new style rules.
- **Readers no longer get a password from an administrator.** `POST /api/admin/readers` takes `username` and `email` and answers with `invite.url`; `PUT /api/admin/readers/:id` refuses `password` with a 400. Readers who already have a password keep it.
- **Usernames are now unique whatever their case.** If an installation has two accounts of the same kind whose names differ only by case, the newer one is renamed on the first start (its name gets a short suffix). Check the list of readers and administrators after updating.
- The reader and administrator pages use two new rules in `sites/label/app.css` (`input[type=email]` and `td.wrap`). An installation with its own `app.css` should copy them.
- **New passwords need at least 10 characters** (it was 8) and cannot be the account's name or email. Passwords that already exist keep working.
- **A Linux server** should say where the visitor's address comes from in a new optional file, `sites/gatefold.json` (see "Behind a reverse proxy" in the README). Until it does, the address recorded is the `CF-Connecting-IP` header of the request, which only Cloudflare can be trusted to set: on a server that is not behind Cloudflare, set `client_ip` to the header your proxy writes, or to `none`.
- **Audit entries are now removed after 180 days.** Whoever holds the root password can change the period at `/root/setup` (90 to 3650 days).
- `POST /api/admin/login` and `POST /api/reader/login` now refuse a request a browser says came from another site, as the sign-in pages already did.

### Added

- **Uploaded sources.** An administrator creates a source and uploads the folder of its site in the console (**Sources → Add source**, then **Upload folder**); the files are kept in the file storage (R2 on Cloudflare, `.data/` elsewhere) and a change is live at once.
- **An API for the files of a source**, for scripts in other repositories: `POST /api/admin/sources`, and `GET`, `PUT` and `DELETE` on `/api/admin/sources/:alias/files/<path>`, with an administrator API key. See "Publish from a script" in the README.
- Creating a source and uploading or removing its files are recorded in the audit log: one entry for each source, administrator and hour, with how many files.
- **Access links.** A reader is created with a username and an email, and chooses their own password through a link that works once and expires in 72 hours (`/reader/invite/<token>`). The same link lets a reader choose a new password. `POST` and `DELETE /api/admin/readers/:id/invite` issue and revoke it.
- **Audit log.** Every change made to the database is recorded in the same operation as the change: who, how they were authenticated, from which address, what and on whom. Sign-ins, refused sign-ins and refused root passwords are recorded too. See it under **Audit log** in the console or at `GET /api/admin/audit`.

- **`npm run update`, `npm run repair` and `npm run doctor`** (the `gatefold/` folder): update an installation to a released version keeping its `sites/` and its data, put the installed version's files back, and check an installation. `gatefold/manifest.json` records the version and a fingerprint of every file of the app.
- **Limits on guessing.** Wrong passwords are counted per account and per address and block the sign-in for 15 minutes; the root password is counted per address. Blocks are recorded in the audit log.
- **Your account:** `/admin/account`, `/reader/account` and `PUT /api/<role>/password` change one's own password and sign the other sessions out.
- **Suspending and reactivating** readers and administrators (`POST /api/admin/{readers,admins}/:id/suspend` and `/reactivate`, and buttons on their pages). Root can reactivate an administrator.
- **API keys** take a `name` and `expires_in_days`, and record when they were last used.
- **More in the audit log:** a reader opening a private source or being refused one (once an hour for each reader and source), access links that do not work, and requests refused for coming from another site. `GET /api/admin/audit.csv` and the **Export CSV** button download the log; the export is recorded.
- **Retention policy, set by root only:** `GET` and `PUT /api/root/settings` and a **Policy** card on `/root/setup`.
- **Security headers on every answer.** `Strict-Transport-Security` where the installation is reached by HTTPS, a strict Content-Security-Policy on API answers, and `frame-ancestors 'self'` on the files of a source.
- **`sites/gatefold.json`**, optional: where the visitor's address comes from (`client_ip`) and the installation's public address (`public_url`).

### Changed

- A page that fails to render no longer shows the reader the file's path and the template error: both go to the server log.
- The project is now a neutral white-label base named Gatefold. Package, Worker, secrets (`GATEFOLD_*`), cookies and database identifier were renamed: an installation published under the old name starts again with new secrets and an empty database.
- The whole design of the system pages moved to `sites/label/` (`theme.css` for the tokens, `app.css` for the rules), with a new neutral look. No stylesheet is built into the code.
- Published sites are no longer folders of the repository: they are uploaded (see the upgrade notes). A new source starts private.
- The rendered extensions and the props of a source are read from an optional `source.json` among its files, and are no longer edited in the console or through the API. A source without that file keeps the values it had.
- `PUT /api/admin/sources/:alias` accepts only `public`.
- `deps.sites.folders(parent)` lists the subfolders of one subfolder of `sites/`.
- Signing in ignores the case of the username.

### Removed

- All Moljud branding (logos, colours, fonts, texts). See `LICENSE-SUPPLEMENT.md`.
- `GET /api/admin/available-sources`.
- The example site in `sites/sources/example/`.

## [0.1.0] - 2026-11-21

First public release.

### Added

- Read-only sites served from a folder per site at `/reader/view/<name>/`, private (per reader) or public.
- Administrator console, reader library and the root setup page.
- A JSON API for everything the pages do, with API keys.
- A Liquid-style template engine with platform, source and reader props.
- White-label branding from `sites/label/`.
- Runs on Cloudflare Workers or as a Linux service, with a single SQLite database.

[Unreleased]: https://github.com/newmoljud/moljud-pages/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/newmoljud/moljud-pages/compare/v0.1.0...v0.6.1
[0.1.0]: https://github.com/newmoljud/moljud-pages/releases/tag/v0.1.0
