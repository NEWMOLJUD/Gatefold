# Changelog

Notable changes to Gatefold are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The project is now a neutral white-label base named Gatefold. Package, Worker, secrets (`GATEFOLD_*`), cookies and database identifier were renamed: an installation published under the old name starts again with new secrets and an empty database.
- The whole design of the system pages moved to `sites/label/` (`theme.css` for the tokens, `app.css` for the rules), with a new neutral look. No stylesheet is built into the code.
- Published sites moved from `sites/<name>/` to `sites/sources/<name>/`.
- Every folder of `sites/sources/` is now a source without being registered. A new one starts private.
- The rendered extensions and the props of a source are read from an optional `source.json` in its folder, and are no longer edited in the console or through the API. A source without that file keeps the values it had.
- `PUT /api/admin/sources/:alias` accepts only `public`. `DELETE /api/admin/sources/:alias` works only for a source whose folder is no longer published.
- `deps.sites.folders(parent)` lists the subfolders of one subfolder of `sites/`.

### Removed

- All Moljud branding (logos, colours, fonts, texts). See `LICENSE-SUPPLEMENT.md`.
- `GET /api/admin/available-sources`.
- `POST /api/admin/sources` and the `/admin/create-source` page.

## [0.1.0] - 2026-11-21

First public release.

### Added

- Read-only sites served from a folder per site at `/reader/view/<name>/`, private (per reader) or public.
- Administrator console, reader library and the root setup page.
- A JSON API for everything the pages do, with API keys.
- A Liquid-style template engine with platform, source and reader props.
- White-label branding from `sites/label/`.
- Runs on Cloudflare Workers or as a Linux service, with a single SQLite database.

[Unreleased]: https://github.com/newmoljud/moljud-pages/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/newmoljud/moljud-pages/releases/tag/v0.1.0
