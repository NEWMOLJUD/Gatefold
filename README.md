<!-- redoma:project -->
<!-- Everything in this file sits between the redoma:project markers on purpose: `npm run update` keeps what is inside them. -->
<div align="center">

# Gatefold

**Publish private, read-only sites to the right people, under your own brand.**

Open source · white-label · [MIT](LICENSE)

</div>

<br>

Put a static site in a folder, commit it, and Gatefold serves it behind a sign-in. You decide which readers open which site. It runs on Cloudflare Workers or on your own Linux server, and keeps everything in a single SQLite database.

- **One folder per site.** `sites/sources/handbook/` is served at `/reader/view/handbook/`.
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
2. Sign in at `/admin/`. Under **Sources**, `example` is already listed: every folder of `sites/sources/` is a source, private until you decide otherwise.
3. Under **Readers**, add a reader with a username and an email. You get a link: copy it. Then tick `example` on the reader's page.
4. Open the link as the reader would, choose a password, and you are in the reader's library.

## Publish without a terminal

You can publish from the GitHub and Cloudflare websites alone, with nothing installed on your computer.

**1. Create your repository.** On GitHub press **Use this template** and choose **Private**. Whoever can read the repository can read every site in it.

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

**3. Create the Worker.** In the [Cloudflare dashboard](https://dash.cloudflare.com): **Workers & Pages → Create application → GitHub**, pick your repository, name the Worker **`gatefold`** and leave the build command empty.

> [!NOTE]
> The name must be exactly `gatefold`, because that is the name written in `wrangler.jsonc`. A different name needs `npm run rename` in a terminal, once.

**4. Add the secrets.** In **Workers & Pages → your Worker → Settings → Variables and Secrets**, press **Add**, choose the type **Secret** (not *Text*, which leaves the value visible), and create these three, each with one of the values you generated. Then press **Deploy**.

```
GATEFOLD_ROOT_PASSWORD
GATEFOLD_MASTER_KEY
GATEFOLD_SIGNING_KEY
```

The names must be typed exactly like this. The first publication happens before the secrets exist, so until this step is done, signing in and `/root/setup` answer with an error: that is expected.

**5. Create the first accounts.** Open the address Cloudflare gave your Worker and follow step 5 of the [Quick start](#quick-start): at `/root/setup`, the root password is the value you gave `GATEFOLD_ROOT_PASSWORD`.

From here on, every push to the main branch publishes, and files can be added to `sites/sources/` on the GitHub website itself.

## Add your sites

Copy each site into its own folder under `sites/sources/` (lowercase letters, digits and hyphens), with an `index.html` at its root, commit and publish. The folder then shows up under **Sources** in the console on its own, private: choose there who reads it, or make it public. The extensions that are rendered and the source's props are written in an optional `source.json` inside the folder, described in [`sites/README.md`](sites/README.md).

```
sites/
  sources/
    handbook/      →  /reader/view/handbook/
    price-list/    →  /reader/view/price-list/
  label/           →  the brand and design of the system pages (not a site)
```

Links between pages of a site should be relative (`about/`, `../style.css`). Delete `sites/sources/example/` when you no longer need it.

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
| `/reader/view/<site>/<file>` | A file of `sites/sources/<site>/`. A folder address delivers its `index.html`. |
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

- **Data:** one SQLite database. On your computer and on Linux it is in `.data/`: that folder is your backup.
- **Sessions** last 7 days.
- **Passwords** have at least 10 characters, and cannot be the account's name or email, nor one of the passwords everybody tries first.
- **Readers choose their own password.** Adding a reader gives you a link (`/reader/invite/…`) that works once and expires in 72 hours. Gatefold sends no email: you send the link. For a new password, generate a new link on the reader's page; no administrator ever sees or sets a reader's password.
- **Usernames** are unique whatever their case: `Ana` and `ana` are the same account.
- **Audit log:** every change (accounts, permissions, visibility, props, API keys, sign-ins and refused sign-ins) is recorded with who, when and from where, under **Audit log** in the console and at `GET /api/admin/audit`. Entries cannot be edited or removed. They never hold a password, a key or a link.
  - It also records a reader opening a private source (once an hour for each reader and source), a reader refused a source, access links that do not work and requests refused for coming from another site.
  - **Export CSV** downloads what the filters show (`GET /api/admin/audit.csv`, up to 5000 entries per file). Exporting is recorded too.
  - Entries are kept for 180 days and then removed by a daily job, which leaves an entry saying how many it removed. Only whoever holds the root password changes that period, at `/root/setup` (90 to 3650 days): an administrator cannot shorten their own trail.
- **Root password:** 5 wrong attempts per hour, then it locks until the next hour.
- **Limits:** props up to 64,000 characters; files over 1 MB are delivered without templating; on Cloudflare, `sites/` holds up to 20,000 files of 25 MB each.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run locally and print the address. |
| `npm run test` | Check types and run the tests. |
| `npm run deploy` | Check and publish to Cloudflare. |
| `npm run secret set NAME` / `list` / `remove NAME` | Manage secrets. Values are never shown. |
| `npm run service:install` / `status` / `remove` | Run as a Linux service. |
| `npm run watcher:install` / `remove` | Pull new commits and restart the service. |

## Contributing

Issues and pull requests are welcome. The app is in `sandbox/` (TypeScript, no runtime dependencies). Run `npm run test` before sending a change.

- [CONTRIBUTING.md](CONTRIBUTING.md): how to set up, the project limits and what a pull request needs.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): how we treat each other.
- [SECURITY.md](SECURITY.md): how to report a vulnerability **privately**, and how the app is meant to be trusted.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.

Gatefold is built on [Redoma](https://github.com/MateusMoutinhoOrg/Redoma), a TypeScript server template for Cloudflare Workers and Linux; its README is the full manual of the commands above. Running `npm run update` brings Redoma's newer machinery and adds its manual around this text.

## License

[MIT](LICENSE), complemented by [LICENSE-SUPPLEMENT.md](LICENSE-SUPPLEMENT.md): no Moljud name, logo or proprietary material is part of this project. If you find any here, do not use it, and contact Moljud so it can be removed. Third-party material is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
<!-- /redoma:project -->
