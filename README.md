<!-- redoma:project -->
<!-- Everything in this file sits between the redoma:project markers on purpose: the machinery's own update keeps what is inside them. -->
<div align="center">

# Gatefold

**Publish private, read-only sites to the right people, under your own brand.**

Open source · white-label · [MIT](LICENSE)

</div>

<br>

Upload the folder of a static site, and Gatefold serves it behind a sign-in. You decide which readers open which site. It runs on Cloudflare Workers or on your own Linux server, with a single SQLite database and a file storage for the sites.

- **One upload per site.** Choose the folder in the console, or send it from a script: the source `handbook` is served at `/reader/view/handbook/`.
- **Access per reader.** A site is private (only the readers you pick) or public (anyone).
- **Templates.** `{{ props.title }}`, `{% if %}`, `{% for %}`: pages adapt to the reader.
- **Your brand.** Name, logo, colours and the whole design live in one folder, `sites/label/`. No code to touch.
- **An API for everything.** Whatever the console does, a script can do with an API key.

## Quick start

You need [Node.js](https://nodejs.org) 22.18 or newer.

> [!TIP]
> No terminal? Follow [Publish without a terminal](#publish-without-a-terminal) instead: everything is done in the browser.

**1. Create your repository.** On GitHub press **Use this template** and choose **Private**.

> [!WARNING]
> Whoever can read the repository can read every site in it, including the private ones.

**2. Install and name it.**

```bash
npm install
```

```bash
npm run rename my-company-pages
```

**3. Set the three secrets.** Each command asks for the value at a hidden prompt. Use long random values, all different.

```bash
npm run secret set GATEFOLD_ROOT_PASSWORD
```

```bash
npm run secret set GATEFOLD_MASTER_KEY
```

```bash
npm run secret set GATEFOLD_SIGNING_KEY
```

| Secret | What it is for | If you change it later |
|---|---|---|
| `GATEFOLD_ROOT_PASSWORD` | Opens `/root/setup`, where administrators are created. | Nothing breaks. |
| `GATEFOLD_MASTER_KEY` | Protects every password and API key. **Keep a copy.** | Every password and API key stops working. |
| `GATEFOLD_SIGNING_KEY` | Signs the session cookies. | Everyone is signed out. |

**4. Start it.**

```bash
npm run dev
```

**5. Create the first accounts.** Open the address it printed, then:

1. At `/root/setup`, type the root password and create an administrator.
2. Sign in at `/admin/`. Under **Sources**, press **Add source**, give it an alias (`handbook`, say) and upload the folder of a site: any folder with an `index.html`. It is private until you decide otherwise.
3. Under **Readers**, add a reader with a username and an email. You get a link: copy it. Then tick `handbook` on the reader's page.
4. Open the link as the reader would, choose a password, and you are in the reader's library.

## Publish without a terminal

You can publish from the GitHub and Cloudflare websites alone, with nothing installed on your computer.

**1. Create your repository.** On GitHub press **Use this template** and choose **Private**.

**2. Generate the three keys.** The app needs three secrets, and each one is simply a long random text. Generate **three different values**, one for each name in the [table above](#quick-start):

- [IT Tools token generator](https://it-tools.tech/token-generator?length=64&symbols=false): this link opens it already set to 64 letters and digits. Press **Copy**, then **Refresh** for the next key.
- [RandomKeygen](https://randomkeygen.com/): press **256-bit Hex** and copy one of the values shown.

Both are open tools that generate the value inside your browser, with nothing to sign up for. If you use another generator, ask for **40 characters or more** and only letters and digits, so nothing is lost when you copy and paste.

Prefer not to use a website? Open your browser's console (press **F12**, then **Console**), paste this line and press Enter. Run it three times, once per key, and copy the text between the quotes:

```js
crypto.randomUUID() + crypto.randomUUID()
```

> [!IMPORTANT]
> Save the three values in a password manager before going on. Cloudflare never shows a secret again, and if `GATEFOLD_MASTER_KEY` is lost or replaced, every password and API key stops working.

**3. Turn on R2.** Gatefold keeps the files of your sites in Cloudflare's file storage, R2. In the [Cloudflare dashboard](https://dash.cloudflare.com) open **R2** and finish its one-time setup (Cloudflare asks for a payment method even for the free allowance). Without this step the publication fails.

**4. Create the Worker.** In the Cloudflare dashboard: **Workers & Pages → Create application → GitHub**, pick your repository, name the Worker **`gatefold`** and leave the build command empty.

> [!NOTE]
> The name must be exactly `gatefold`, because that is the name written in `wrangler.jsonc`. A different name needs `npm run rename` in a terminal, once.

**5. Add the secrets.** In **Workers & Pages → your Worker → Settings → Variables and Secrets**, press **Add**, choose the type **Secret** (not *Text*, which leaves the value visible), and create these three, each with one of the values you generated. Then press **Deploy**.

```
GATEFOLD_ROOT_PASSWORD
GATEFOLD_MASTER_KEY
GATEFOLD_SIGNING_KEY
```

The names must be typed exactly like this. The first publication happens before the secrets exist, so until this step is done, signing in and `/root/setup` answer with an error: that is expected.

**6. Create the first accounts.** Open the address Cloudflare gave your Worker and follow step 5 of the [Quick start](#quick-start): at `/root/setup`, the root password is the value you gave `GATEFOLD_ROOT_PASSWORD`.

From here on, every push to the main branch publishes the app. Your sites are not in the repository: you upload them in the console.

## Add your sites

A site is a **source**. In the console, under **Sources**, press **Add source** and give it an alias (lowercase letters, digits and hyphens): the alias is its address, `/reader/view/<alias>/`. Then, on the source's page, choose the folder of the site and press **Upload folder**. Every file is sent, keeping its subfolders.

- The folder needs an `index.html` at its root: it is what `/reader/view/<alias>/` delivers. Links between pages should be relative (`about/`, `../style.css`).
- A new source is **private**: choose who reads it on each reader's page, or make it public.
- **A change is live at once.** Uploading the folder again replaces the files that changed; tick **Remove what is not in this folder** to also delete the ones you removed. Nothing is versioned: keep the site's own source somewhere else.
- Files and folders whose name starts with a dot are left out. A file can have up to 25 MB, and a source up to 20,000 files.

### source.json

A source can carry its own settings in a `source.json` at its root, uploaded with the rest. The file is optional, is read by the system only, and is never delivered to readers:

```json
{
  "render": ["html"],
  "props": { "title": "Handbook" }
}
```

- `render`: the file extensions that go through the template engine. Without the file it is `["html"]`; an empty list turns rendering off. Careful with `js` and `css`: a file that already contains `{{` or `{%` (Vue or Handlebars code, for instance) would be interpreted, so protect those parts with `{% raw %}…{% endraw %}`. Images, PDFs, fonts and videos are never rendered.
- `props`: values the templates of this source read as `{{ props.key }}`. They win over the platform props, and the reader's own props win over them.

Whatever is wrong in the file falls back to the default of that key, and the source's page in the console lists the problems. Who may read the source is not set here: visibility and permissions stay in the console.

### Publish from a script

Everything the upload does is in the API, so the build of a site in another repository can publish it. Create an administrator API key under **API keys** and keep it as a secret of that repository or of its CI: never write it in a file.

| Request | What it does |
|---|---|
| `POST /api/admin/sources` with `{"alias": "handbook"}` | Creates the source (add `"public": true` to open it to everyone). |
| `PUT /api/admin/sources/<alias>/files/<path>` | Adds the file at that path, or replaces it. The body of the request is the content of the file. 201 for a new file, 200 for a replacement. |
| `GET /api/admin/sources/<alias>/files` | Lists the files: `q` (path prefix), `limit` (up to 1000) and `after` (the `next_after` of the previous answer). |
| `GET /api/admin/sources/<alias>/files/<path>` | Downloads one file as it was uploaded. |
| `DELETE /api/admin/sources/<alias>/files/<path>` | Removes one file. |
| `DELETE /api/admin/sources/<alias>` | Removes the source, its permissions and all its files. |

Sending a whole folder from a terminal, with the key and the address in two environment variables:

```bash
cd my-site && find . -type f ! -path '*/.*' | sed 's|^\./||' | while IFS= read -r file; do
  curl -fsS -o /dev/null -X PUT -H "Authorization: Bearer $GATEFOLD_KEY" -T "$file" "$GATEFOLD_URL/api/admin/sources/handbook/files/$file" || echo "failed: $file"
done
```

A file name with a space or another character an address does not take must be percent-encoded (`my%20file.pdf`). The type of each file comes from its extension.

> [!WARNING]
> An administrator key can do everything an administrator can, on every source. Whoever gets it can publish any page on your address. Give it an end date, and revoke it under **API keys** as soon as it is no longer used.

## Make it your brand

Everything visual is in [`sites/label/`](sites/label/README.md): name, logo and favicon (`label.json`), colours, corners and typefaces (`theme.css`), and the full stylesheet of the system pages (`app.css`). The name "Gatefold" and the logo that ship there are neutral placeholders: replace them with yours before publishing.

## Publish

| Where | How |
|---|---|
| **Cloudflare, through Git** | In the [dashboard](https://dash.cloudflare.com): **Workers & Pages → Create application → GitHub**, pick the repository, use the name you gave `npm run rename` and leave the build command empty. Every push to the main branch publishes. |
| **Cloudflare, from a terminal** | `npm run deploy` |
| **Your own Linux server** | `npm run service:install` (port 3000, plain HTTP: put a reverse proxy in front for HTTPS). `npm run watcher:install` makes it follow the repository. |

The three secrets must exist **where the app runs**:

- **Through Git:** add them in the dashboard, **Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, type **Secret**. [Publish without a terminal](#publish-without-a-terminal) shows how to generate the values in the browser.
- **From a terminal:** `npm run secret set NAME` already sent them.
- **Linux server:** run `npm run secret set NAME` on the server.

### Behind a reverse proxy

On Cloudflare there is nothing to set. On a Linux server behind a reverse proxy, the app sees the proxy's address and plain HTTP instead of the visitor's, so tell it where it runs in an optional `sites/gatefold.json` (not a secret, and never served to anyone):

```json
{
  "client_ip": "x-forwarded-for",
  "public_url": "https://pages.example.com"
}
```

| Key | What it is | Default |
|---|---|---|
| `client_ip` | The header the visitor's address is read from, for the audit log: `cloudflare` (`CF-Connecting-IP`), `x-forwarded-for`, `x-real-ip`, or `none`. Name only a header your proxy sets on every request: a header nothing sets can be written by anyone. On a server reached directly, use `none`. | `cloudflare` |
| `public_url` | The address people type. Access links are built from it, and so is the check that a change came from this site. Without it, behind a proxy that ends HTTPS, links would say `http://` and forms would be refused. | What the app sees |

## Reference

### Addresses

| Address | What it is |
|---|---|
| `/reader/` | Reader sign-in and library. |
| `/reader/view/<site>/<file>` | A file of the source `<site>`. A folder address delivers its `index.html`. |
| `/admin/` | Administrator sign-in and console. |
| `/root/setup` | Creates and removes administrators with the root password. |
| `/api/admin/*`, `/api/reader/*` | The same operations in JSON, with `Authorization: Bearer <key>`. Routes are listed in [`sandbox/api.ts`](sandbox/api.ts). |
| `/label/<file>` | The brand files. Public. |

### Templates

HTML files go through a small template engine before delivery:

```html
<h1>{{ props.company }}</h1>
{% if props.plan == "gold" %}…{% else %}…{% endif %}
{% for item in props.notices %}{{ forloop.index }}. {{ item }}{% endfor %}
```

- **`props`** are JSON values merged in this order, the later winning: platform → source → reader.
- **`query`** is the address query string; **`headers`** the request headers (never cookies or credentials).
- Output is HTML-escaped. Filters: `raw`, `json`, `default: "value"`, `upper`, `lower`, `size`.

> [!IMPORTANT]
> Props personalise pages. They are **not** access control: readers can edit their own. Access is decided only by the source's visibility and the reader's permissions.

### Good to know

- **Data:** one SQLite database, and the files of the sources in a file storage (R2 on Cloudflare). On your computer and on Linux both are in `.data/`: that folder is your backup.
- **Sessions** last 7 days.
- **Passwords** have at least 10 characters, and cannot be the account's name or email, nor one of the passwords everybody tries first.
- **Readers choose their own password.** Adding a reader gives you a link (`/reader/invite/…`) that works once and expires in 72 hours. Gatefold sends no email: you send the link. For a new password, generate a new link on the reader's page; no administrator ever sees or sets a reader's password.
- **Usernames** are unique whatever their case: `Ana` and `ana` are the same account.
- **Audit log:** every change (accounts, permissions, visibility, props, API keys, sign-ins and refused sign-ins) is recorded with who, when and from where, under **Audit log** in the console and at `GET /api/admin/audit`. Entries cannot be edited or removed. They never hold a password, a key or a link.
  - It also records a reader opening a private source (once an hour for each reader and source), a reader refused a source, access links that do not work and requests refused for coming from another site.
  - **Export CSV** downloads what the filters show (`GET /api/admin/audit.csv`, up to 5000 entries per file). Exporting is recorded too.
  - Entries are kept for 180 days and then removed by a daily job, which leaves an entry saying how many it removed. Only whoever holds the root password changes that period, at `/root/setup` (90 to 3650 days): an administrator cannot shorten their own trail.
- **Root password:** it must have at least 32 characters, or root access is off. 5 wrong attempts in an hour lock it for an hour, for the address they came from. Where the app cannot tell addresses apart (see [Behind a reverse proxy](#behind-a-reverse-proxy)), that is everyone.
- **Sign-in:** 5 wrong passwords for the same account from the same address block that pair for 15 minutes. A good password takes the wrong ones back.
- **Your account:** everyone changes their own password, saying the current one. An administrator's lost password is set again by whoever holds the root password, at `/root/setup`; a reader's, by a new access link.
- **Suspending** an account signs it out and keeps it out (sessions, API keys, access links) without removing anything. The last administrator who can sign in cannot be suspended or removed, except by root.
- **API keys** have a name, can be given an end (30 days, 90 days, a year, or any number of days through the API) and show when they were last used.
- **Removing a source** takes it away from readers at once. Its stored files are then deleted a few at a time, in the background: a very large source takes a few hours to free its space.
- **Limits:** props up to 64,000 characters; files over 1 MB are delivered without templating; a source holds up to 20,000 files of 25 MB each.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run locally and print the address. |
| `npm run test` | Check types and run the tests. |
| `npm run deploy` | Check and publish to Cloudflare. |
| `npm run secret set NAME` / `list` / `remove NAME` | Manage secrets. Values are never shown. |
| `npm run service:install` / `status` / `remove` | Run as a Linux service. |
| `npm run watcher:install` / `remove` | Pull new commits and restart the service. |
| `npm run update` | Bring this installation to the newest Gatefold: the app and the machinery it was tested with. Your `sites/` and your data stay. See [`gatefold/README.md`](gatefold/README.md). |
| `npm run repair` | Put the files of the installed version back as they shipped. |
| `npm run doctor` | Say what is wrong or worth knowing about this installation. Changes nothing. |

### Updating

`npm run update` shows the version you have, the one you are getting, what changed between them and every file it will replace, and asks before doing anything. It needs a terminal and a repository with everything committed, so that one command undoes it.

- **Your sources, your brand and your data are not touched.** The one file of `sites/` an update may change is `sites/label/app.css`, because new pages need new style rules: yours is merged with them, and when that does not fit, the new stylesheet is left beside it as `app.css.new`.
- **Back up before publishing an update.** A new version may add to the database when it first runs, and the old code cannot read what it does not know: after that, going back means restoring the backup.
- **Publishing through Git:** run the update on your computer, review it, commit and push.

## Contributing

Issues and pull requests are welcome. The app is in `sandbox/` (TypeScript, no runtime dependencies). Run `npm run test` before sending a change.

- [CONTRIBUTING.md](CONTRIBUTING.md): how to set up, the project limits and what a pull request needs.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): how we treat each other.
- [SECURITY.md](SECURITY.md): how to report a vulnerability **privately**, and how the app is meant to be trusted.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.

Gatefold is built on [Redoma](https://github.com/MateusMoutinhoOrg/Redoma), a TypeScript server template for Cloudflare Workers and Linux; its README is the full manual of the commands it provides. `npm run update` brings the version of that machinery each Gatefold release was tested with.

## License

[MIT](LICENSE), complemented by [LICENSE-SUPPLEMENT.md](LICENSE-SUPPLEMENT.md): no Moljud name, logo or proprietary material is part of this project. If you find any here, do not use it, and contact Moljud so it can be removed. Third-party material is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
<!-- /redoma:project -->
