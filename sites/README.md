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

- Name the subfolder with lowercase letters, digits and hyphens only.
- Put an `index.html` at the root of the subfolder: that is how the system recognises it.
- A subfolder becomes readable only after an administrator registers it at `/admin/create-source`, by typing its name.
- `example/` is just a starting point: delete it or replace it with your content.
- Files and folders whose name starts with a dot are never delivered.

## label/

Not a site: it holds your logo, colours and stylesheets. See [`label/README.md`](label/README.md).
