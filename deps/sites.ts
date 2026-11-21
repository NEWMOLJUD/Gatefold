/**
 * Read-only access to the `sites/` folder at the root of the repository. The
 * folder is published together with the app and is never served directly:
 * a visitor only receives a file that a route decided to send. To change a
 * file, change it in the repository and publish again.
 *
 * Limits: `sites/` and `sandbox/public/` cannot be used in the same project.
 * On Cloudflare the folder holds at most 20,000 files of at most 25 MB each.
 */
export interface Sites {
  /**
   * Names of the direct subfolders of `sites/`, sorted. The list is taken
   * when the app is built: a folder added later appears after the next
   * publish (or the next start of `npm run dev`).
   * @example
   * const available = sites.folders(); // ["docs", "manual"]
   */
  folders(): string[];

  /**
   * The file `sites/<path>` as a `Response` (body, `Content-Type`, `ETag`), or
   * `null` when it does not exist. `path` uses `/` and never leaves the
   * folder: a path with `..`, `.`, an empty segment, a `\` or a segment that
   * starts with a dot (hidden files) is answered with `null`.
   * @example
   * server.route("GET", "/docs/*", async (_request, params) =>
   *   (await sites.get(`docs/${params["*"]}`)) ?? new Response("Not found", { status: 404 }));
   */
  get(path: string): Promise<Response | null>;
}
