# Security policy

Gatefold keeps private sites behind a sign-in, so security reports are taken seriously. Thank you for helping keep its users safe.

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

Problems in the machinery under `engine/`, `deps/` and `scripts/` usually belong to [Redoma](https://github.com/MateusMoutinhoOrg/Redoma), the template this project is built on. Report them here anyway if they affect Gatefold; we will forward them.

Out of scope: problems that need access to the repository, to the server or to the Cloudflare account of the installation; the content of the sites an installation serves; missing hardening with no practical attack.

## How the app is meant to be trusted

Knowing these design decisions helps you run it safely, and tells you what is and is not a vulnerability.

- **Whoever can push to the repository can change the code that runs.** Keep the repository of an installation private. The sites themselves are not in it: they are uploaded, and live in the installation's file storage.
- **Sites are trusted content.** The files of a source are served from the same address as the administrator console. A script inside a site can act with the session of whoever opens it, an administrator included. Publish only sites you wrote or reviewed.
- **Whoever can upload can publish a script.** Every administrator, and every administrator API key, can add and replace the files of any source, and so can put a page with a script on the installation's own address. An administrator key kept in another repository or in a CI system has that power: store it as a secret there, give it an end date, and revoke it when it is no longer used. Uploads are recorded in the audit log, by source and by hour.
- **An upload is live at once and is not versioned.** A replaced or removed file cannot be brought back from the installation: keep the site's own source somewhere else.
- **Templates escape output by default.** The `raw` filter turns that off: never use it on `query`, `headers` or on props a reader can edit.
- **Props are not access control.** Readers can edit their own props, and theirs win over the source's. Access is decided only by the source's visibility and the reader's permissions.
- **Three secrets hold the installation.** `GATEFOLD_ROOT_PASSWORD` creates administrators, `GATEFOLD_MASTER_KEY` protects password and API key hashes, `GATEFOLD_SIGNING_KEY` signs sessions. Use long random values, all different, and never commit them. Changing the signing key ends every session.
- **Guessing is counted, and the count can be used against an account.** 5 wrong passwords for one account from one address block that pair for 15 minutes; 20 for one account from anywhere, or 50 from one address, block it too. Someone who knows a username and has many addresses can therefore keep that account locked. The app has no rate limiter to do better: on Cloudflare, add a rate limiting rule for `/admin/`, `/reader/` and `/api/*/login`.
- **The root password is counted per address.** 5 wrong attempts in an hour lock root for the address they came from, and 100 from all addresses together lock it for everyone. Where the app cannot tell addresses apart (`client_ip` unset on a server that is not behind Cloudflare), every visitor is the same address, and a stranger can lock root for an hour. A root password shorter than 32 characters turns root access off.
- **Root is the way back in, and the one check on administrators.** Only root sets another administrator's password, removes or suspends the last administrator, and decides how long the audit log is kept. Whoever holds the root password holds the installation.
- **The app says who may frame it, not what a site may load.** System pages and API answers carry a strict Content-Security-Policy. Files of a source carry only `frame-ancestors 'self'`: what a site loads and runs is decided by whoever wrote it. HTTPS is made sticky (`Strict-Transport-Security`) wherever the installation is reached by HTTPS.
- **A request with neither `Origin` nor `Sec-Fetch-Site` is accepted.** Browsers send one of them on every cross-site form or fetch, so their absence means a script, not a tricked browser. Scripts should use API keys.
- **The visitor's address in the audit log is only as good as its source.** It is read from one header, chosen in `sites/gatefold.json` (`client_ip`). On Cloudflare the default is right. On a Linux server, name the header your reverse proxy sets, or `none`: a header that nothing in front of the app sets can be written by the visitor.
- **On a Linux server the service speaks plain HTTP on every network interface.** Put a reverse proxy with HTTPS in front of it, close the service port to the outside with a firewall, and run it as a user that is not root. The watcher installs and runs whatever is pushed to the branch it follows: protect that branch.
