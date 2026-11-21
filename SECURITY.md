# Security policy

Moljud Pages keeps private sites behind a sign-in, so security reports are taken seriously. Thank you for helping keep its users safe.

## Supported versions

Only the latest release on the `main` branch receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub: open the repository's **Security** tab and press **Report a vulnerability**, or go straight to [the private report form](https://github.com/newmoljud/moljud-pages/security/advisories/new).

Include, as far as you can:

- what the problem is and what an attacker could do with it;
- the steps, request or proof of concept that shows it;
- where the app was running (Cloudflare Workers or a Linux server) and the version or commit.

Never include real passwords, keys or private content. Test only against an installation you own.

What to expect:

- an acknowledgement within 5 working days;
- an assessment, and a plan when the report is confirmed, within 15 working days;
- credit in the release notes when the fix is published, unless you prefer to stay anonymous.

Please give us a reasonable time to publish a fix before disclosing the problem.

## Scope

In scope: the code in this repository, that is, the app in `sandbox/` and the way it is run and published.

Problems in the machinery under `engine/`, `deps/` and `scripts/` usually belong to [Redoma](https://github.com/MateusMoutinhoOrg/Redoma), the template this project is built on. Report them here anyway if they affect Moljud Pages; we will forward them.

Out of scope: problems that need access to the repository, to the server or to the Cloudflare account of the installation; the content of the sites an installation serves; missing hardening with no practical attack.

## How the app is meant to be trusted

Knowing these design decisions helps you run it safely, and tells you what is and is not a vulnerability.

- **Whoever can read the repository can read every site in it.** Keep the repository of an installation private. Whoever can push to it can change the code that runs.
- **Sites are trusted content.** Files in `sites/` are served from the same address as the administrator console. A script inside a site can act with the session of whoever opens it, an administrator included. Publish only sites you wrote or reviewed.
- **Templates escape output by default.** The `raw` filter turns that off: never use it on `query`, `headers` or on props a reader can edit.
- **Props are not access control.** Readers can edit their own props, and theirs win over the source's. Access is decided only by the source's visibility and the reader's permissions.
- **Three secrets hold the installation.** `MOLJUD_PAGES_ROOT_PASSWORD` creates administrators, `MOLJUD_PAGES_MASTER_KEY` protects password and API key hashes, `MOLJUD_PAGES_SIGNING_KEY` signs sessions. Use long random values, all different, and never commit them. Changing the signing key ends every session.
- **The root password locks for everyone.** After 5 wrong attempts in an hour, `/root/setup` refuses every attempt until the next hour, the correct one included.
- **Sign-in attempts are not rate limited by the app.** Use strong passwords, and on Cloudflare consider a rate limiting rule for `/admin/`, `/reader/` and `/api/*/login`.
- **On a Linux server the service speaks plain HTTP on every network interface.** Put a reverse proxy with HTTPS in front of it, close the service port to the outside with a firewall, and run it as a user that is not root. The watcher installs and runs whatever is pushed to the branch it follows: protect that branch.
