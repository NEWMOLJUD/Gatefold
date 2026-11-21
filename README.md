<!-- redoma:project -->
<!-- Everything in this file sits between the redoma:project markers on purpose: `npm run update` keeps what is inside them. -->
<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <img src="docs/logo-light.svg" alt="Moljud Pages" width="360">
</picture>

**Publish private, read-only sites to the right people.**

An open source project by [Moljud](https://moljud.com.br) · [MIT](LICENSE)

</div>

<br>

Put a static site in a folder, commit it, and Moljud Pages serves it behind a sign-in. You decide which readers open which site. It runs on Cloudflare Workers or on your own Linux server, and keeps everything in a single SQLite database.

<p align="center">
  <img src="docs/admin.png" alt="The administrator console: overview of sources, readers and administrators" width="49%">
  <img src="docs/reader.png" alt="The reader library: one card per site the reader can open" width="49%">
</p>

- **One folder per site.** `sites/handbook/` is served at `/reader/view/handbook/`.
- **Access per reader.** A site is private (only the readers you pick) or public (anyone).
- **Templates.** `{{ props.title }}`, `{% if %}`, `{% for %}`: pages adapt to the reader.
- **Your brand.** Name, logo and colours live in one folder. No code to touch.
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
npm run secret set MOLJUD_PAGES_ROOT_PASSWORD
```

```bash
npm run secret set MOLJUD_PAGES_MASTER_KEY
```

```bash
npm run secret set MOLJUD_PAGES_SIGNING_KEY
```

| Secret | What it is for | If you change it later |
|---|---|---|
| `MOLJUD_PAGES_ROOT_PASSWORD` | Opens `/root/setup`, where administrators are created. | Nothing breaks. |
| `MOLJUD_PAGES_MASTER_KEY` | Protects every password and API key. **Keep a copy.** | Every password and API key stops working. |
| `MOLJUD_PAGES_SIGNING_KEY` | Signs the session cookies. | Everyone is signed out. |

**4. Start it.**

```bash
npm run dev
```

**5. Create the first accounts.** Open the address it printed, then:

1. At `/root/setup`, type the root password and create an administrator.
2. Sign in at `/admin/`. Under **Sources**, register `example`.
3. Under **Readers**, add a reader and tick `example`.
4. Sign in as that reader at `/reader/`.

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
> Save the three values in a password manager before going on. Cloudflare never shows a secret again, and if `MOLJUD_PAGES_MASTER_KEY` is lost or replaced, every password and API key stops working.

**3. Create the Worker.** In the [Cloudflare dashboard](https://dash.cloudflare.com): **Workers & Pages → Create application → GitHub**, pick your repository, name the Worker **`moljud-pages`** and leave the build command empty.

> [!NOTE]
> The name must be exactly `moljud-pages`, because that is the name written in `wrangler.jsonc`. A different name needs `npm run rename` in a terminal, once.

**4. Add the secrets.** In **Workers & Pages → your Worker → Settings → Variables and Secrets**, press **Add**, choose the type **Secret** (not *Text*, which leaves the value visible), and create these three, each with one of the values you generated. Then press **Deploy**.

```
MOLJUD_PAGES_ROOT_PASSWORD
MOLJUD_PAGES_MASTER_KEY
MOLJUD_PAGES_SIGNING_KEY
```

The names must be typed exactly like this. The first publication happens before the secrets exist, so until this step is done, signing in and `/root/setup` answer with an error: that is expected.

**5. Create the first accounts.** Open the address Cloudflare gave your Worker and follow step 5 of the [Quick start](#quick-start): at `/root/setup`, the root password is the value you gave `MOLJUD_PAGES_ROOT_PASSWORD`.

From here on, every push to the main branch publishes, and files can be added to `sites/` on the GitHub website itself.

## Add your sites

Copy each site into its own folder under `sites/` (lowercase letters, digits and hyphens), commit and publish. Then register the folder under **Sources** in the console: until then it is invisible.

```
sites/
  handbook/      →  /reader/view/handbook/
  price-list/    →  /reader/view/price-list/
  label/         →  the brand (not a site)
```

Links between pages of a site should be relative (`about/`, `../style.css`). Delete `sites/example/` when you no longer need it.

## Make it your brand

Name, logo, favicon, colours and fonts are in [`sites/label/`](sites/label/README.md). Replace them before publishing your own installation: the Moljud name and logo are trademarks of Moljud and are not covered by the MIT license.

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

## Reference

### Addresses

| Address | What it is |
|---|---|
| `/reader/` | Reader sign-in and library. |
| `/reader/view/<site>/<file>` | A file of `sites/<site>/`. A folder address delivers its `index.html`. |
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
- **Sessions** last 7 days. Readers cannot change their own password; an administrator does it.
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

Moljud Pages is built on [Redoma](https://github.com/MateusMoutinhoOrg/Redoma), a TypeScript server template for Cloudflare Workers and Linux; its README is the full manual of the commands above. Running `npm run update` brings Redoma's newer machinery and adds its manual around this text.

## License

[MIT](LICENSE). The Moljud name and logo are trademarks of Moljud and are not part of the license.
<!-- /redoma:project -->
