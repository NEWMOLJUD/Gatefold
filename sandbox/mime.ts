// What a file is, told from its name. An uploaded file is stored with the type
// its extension gives it: what the uploader says about it is not trusted.

const TEXT = "; charset=utf-8";

const TYPES: Record<string, string> = {
  html: `text/html${TEXT}`, htm: `text/html${TEXT}`, css: `text/css${TEXT}`, js: `text/javascript${TEXT}`, mjs: `text/javascript${TEXT}`,
  json: `application/json${TEXT}`, map: `application/json${TEXT}`, webmanifest: `application/manifest+json${TEXT}`,
  txt: `text/plain${TEXT}`, md: `text/markdown${TEXT}`, csv: `text/csv${TEXT}`, xml: `application/xml${TEXT}`,
  rss: `application/rss+xml${TEXT}`, atom: `application/atom+xml${TEXT}`, vtt: `text/vtt${TEXT}`, ics: `text/calendar${TEXT}`,
  yaml: `text/yaml${TEXT}`, yml: `text/yaml${TEXT}`,
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  ico: "image/x-icon", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg", avi: "video/x-msvideo", mkv: "video/x-matroska",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar", wasm: "application/wasm", epub: "application/epub+zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
};

/** The extension of the file a path names, in lowercase and without the dot; "" when it has none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

/** The `Content-Type` a file is stored and served with. An unknown extension is a download, never a page. */
export function contentTypeOf(path: string): string {
  return TYPES[extensionOf(path)] ?? "application/octet-stream";
}
