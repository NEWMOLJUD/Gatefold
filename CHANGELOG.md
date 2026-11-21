# Changelog

Notable changes to Moljud Pages are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-21

First public release.

### Added

- Read-only sites served from `sites/<name>/` at `/reader/view/<name>/`, private (per reader) or public.
- Administrator console, reader library and the root setup page.
- A JSON API for everything the pages do, with API keys.
- A Liquid-style template engine with platform, source and reader props.
- White-label branding from `sites/label/`.
- Runs on Cloudflare Workers or as a Linux service, with a single SQLite database.

[Unreleased]: https://github.com/newmoljud/moljud-pages/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/newmoljud/moljud-pages/releases/tag/v0.1.0
