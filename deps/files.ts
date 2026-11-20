/**
 * File storage by key: Cloudflare R2 when deployed, the local disk otherwise.
 * Limit: publishing an app that uses it needs R2 enabled on the Cloudflare
 * account (a one-time step in the dashboard). Tell the user first.
 */
export interface Files {
  /**
   * Save `body` under `key`, replacing what was there. A stream of unknown
   * length is buffered in memory first.
   * @example
   * await files.put(`avatars/${userId}.png`, await request.arrayBuffer(), "image/png");
   */
  put(key: string, body: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream, contentType?: string): Promise<void>;

  /**
   * The file as a `Response` (body, `Content-Type`, `ETag`), or `null`.
   * @example
   * server.route("GET", "/avatars/:name", async (_request, { name }) =>
   *   (await files.get(`avatars/${name}`)) ?? new Response("Not found", { status: 404 }));
   */
  get(key: string): Promise<Response | null>;

  /**
   * No error if the file does not exist.
   * @example
   * await files.delete(`avatars/${userId}.png`);
   */
  delete(key: string): Promise<void>;

  /**
   * Files whose key starts with `prefix`, ordered by key, at most 1000.
   * @example
   * const reports = await files.list("reports/2026/");
   */
  list(prefix?: string): Promise<{ key: string; size: number; uploaded: Date }[]>;
}
