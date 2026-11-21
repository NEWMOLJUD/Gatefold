# sites/label/ — your brand

Moljud Pages is white-label: everything a visitor sees of *your* company lives in this folder. Change these files, publish, and the sign-in page, the administrator console and the reader library take your name, logo and colours. No code to touch.

| File | What it controls |
|---|---|
| `label.json` | Product name, sign-in tagline, which files are the logo and the favicon, footer text. |
| `style.css` | Colour palette, corner radius, typefaces. Loaded on every system page after the built-in stylesheet. |
| `logo.svg` | The logo. It is shown on the `--brand-surface` colour (sidebar, top bar, sign-in panel), about 26–34 px tall. |
| `favicon.svg` | The browser tab icon. |
| `*.woff2` | The typefaces `style.css` loads: Plus Jakarta Sans and JetBrains Mono, both under the [SIL Open Font License](https://openfontlicense.org). |

## Rebrand in three steps

1. **Logo.** Replace `logo.svg` and `favicon.svg` with yours. PNG, JPG and WebP work too: put the file here and write its name in `label.json`. Use a version of the logo that reads well on your `--brand-surface` colour (a light logo for a dark surface).
2. **Name.** Edit `label.json`:

   ```json
   {
     "name": "Acme Docs",
     "tagline": "Everything our partners need, in one place.",
     "logo": "logo.svg",
     "favicon": "favicon.svg",
     "footer": "© Acme Inc."
   }
   ```

   Set `"logo": ""` to show the name with its initial instead of an image.
3. **Colours.** Edit the four `--brand…` values in `style.css`, in both the light and the dark block.

## Good to know

- **These files are public.** They are served at `/label/<file>` to everyone, signed in or not, because the sign-in page needs them. Do not put anything private here. Only images, fonts and `.css` files are served; `label.json` and this README are not.
- `label` is a reserved folder name: it can never be registered as a source.
- If `label.json` is missing or broken, the pages fall back to the default name and no logo rather than failing.
- This folder styles the system pages only. The sites you publish in `sites/<alias>/` keep their own look.
- **The Moljud name and logo are trademarks of Moljud.** The files here are the project's default look; replace them before publishing your own installation.
