# sites/label/ — your brand

Gatefold is white-label: everything a visitor sees of *your* company lives in this folder. Change these files, publish, and the sign-in page, the administrator console and the reader library take your name, logo, colours and shapes. No code to touch.

| File | What it controls |
|---|---|
| `label.json` | Product name, sign-in tagline, which files are the logo and the favicon, footer text. |
| `theme.css` | **Start here.** The design tokens: colours (light and dark), corner radius, shadows, typefaces. |
| `app.css` | The full stylesheet of the system pages. It uses only the tokens of `theme.css`; open it for deeper changes. |
| `logo.svg` | The logo. It is shown on the `--brand-surface` colour (sidebar, top bar, sign-in panel), about 26–32 px tall. |
| `favicon.svg` | The browser tab icon. |

The logo and favicon that ship here are neutral placeholders. Replace them with yours.

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
3. **Colours.** Edit the `--brand…` values in `theme.css`, in both the light and the dark block. The other tokens (neutrals, radius, fonts) are there when you want to go further.

To use your own typeface, put the `.woff2` file here, add an `@font-face` rule to `theme.css` with `src: url("/label/<file>.woff2")`, and name the family in `--font`. Fonts from other addresses are blocked by the pages' security policy.

## Good to know

- **These files are public.** They are served at `/label/<file>` to everyone, signed in or not, because the sign-in page needs them. Do not put anything private here. Only images, fonts and `.css` files are served; `label.json` and this README are not.
- **Keep `theme.css` and `app.css`.** Every system page loads both. Without them the pages still work, but unstyled.
- If `label.json` is missing or broken, the pages fall back to the default name and no logo rather than failing.
- This folder styles the system pages only. The sites you publish in `sites/sources/<alias>/` keep their own look.
- The layout of the pages (what goes where) is part of the code in `sandbox/`, not of this folder.
