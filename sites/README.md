# sites/

Each direct subfolder of this folder is a **source**, and the folder name is its alias in the address:

```
sites/<alias>/<file>   →   /reader/view/<alias>/<file>
```

- Name the subfolder with lowercase letters, digits and hyphens only.
- A subfolder becomes readable only after an administrator registers it at `/admin/create-source`.
- `example/` is just a starting point: delete it or replace it with your content.
- Files and folders whose name starts with a dot are never delivered.
- `label/` is not a source: it holds your logo and colours. See [`label/README.md`](label/README.md).
