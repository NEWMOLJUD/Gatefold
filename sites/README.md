# sites/

What the installation is, as files in the repository:

```
sites/
  label/          your brand: name, logo, colours and the design of the system pages
  gatefold.json   optional settings of the installation (see "Behind a reverse proxy" in the README)
```

The sites you publish are **not** here. A source is created and its files are uploaded in the console (**Sources → Add source**) or through the API, and they live in the installation's file storage, not in the repository. See [Add your sites](../README.md#add-your-sites).

A `sites/sources/` folder left from an older version is no longer read: upload each of its subfolders as a source, then delete the folder.

## label/

Not a site: it holds your logo, colours and stylesheets. See [`label/README.md`](label/README.md).
