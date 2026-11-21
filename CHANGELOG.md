# Changelog

Notable changes to Gatefold are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The project is now a neutral white-label base named Gatefold. Package, Worker, secrets (`GATEFOLD_*`), cookies and database identifier were renamed: an installation published under the old name starts again with new secrets and an empty database.
- The whole design of the system pages moved to `sites/label/` (`theme.css` for the tokens, `app.css` for the rules), with a new neutral look. No stylesheet is built into the code.
- Published sites moved from `sites/<name>/` to `sites/sources/<name>/`, and need an `index.html` at their root. A source is registered by typing its folder name.

### Removed

- All Moljud branding (logos, colours, fonts, texts). See `LICENSE-SUPPLEMENT.md`.
- `GET /api/admin/available-sources`.

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
