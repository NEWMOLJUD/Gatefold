# sites/

Two folders, two jobs:

```
sites/
  label/      your brand: name, logo, colours and the design of the system pages
  sources/    the sites you publish, one subfolder each
```

## sources/

Each direct subfolder of `sources/` is a **source**, and the folder name is its alias in the address:

```
sites/sources/<alias>/<file>   →   /reader/view/<alias>/<file>
```

- Name the subfolder with lowercase letters, digits and hyphens only. A folder with any other name is not a source, and the console says so.
- Nobody registers a source: after the next publish the folder shows up under **Sources** in the console on its own.
- A new source is **private**. An administrator decides who reads it, or makes it public, in the console.
- Put an `index.html` at the root of the subfolder: it is what `/reader/view/<alias>/` delivers.
- `example/` is just a starting point: delete it or replace it with your content.
- Files and folders whose name starts with a dot are never delivered.

### source.json

A source can carry its own settings in a `source.json` at its root. The file is optional, is read by the system only, and is never delivered to readers:

```json
{
  "render": ["html"],
  "props": { "title": "Handbook" }
}
```

- `render`: the file extensions that go through the template engine. Without the file it is `["html"]`; an empty list turns rendering off. Careful with `js` and `css`: a file that already contains `{{` or `{%` (Vue or Handlebars code, for instance) would be interpreted, so protect those parts with `{% raw %}…{% endraw %}`. Images, PDFs, fonts and videos are never rendered.
- `props`: values the templates of this source read as `{{ props.key }}`. They win over the platform props, and the reader's own props win over them.

Whatever is wrong in the file falls back to the default of that key, and the source's page in the console lists the problems. Who may read the source is not set here: visibility and permissions stay in the console.

## label/

Not a site: it holds your logo, colours and stylesheets. See [`label/README.md`](label/README.md).
