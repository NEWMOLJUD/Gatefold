/** HTTP routes. A file in `sandbox/public/` wins over a route with the same path. */
export interface Server {
  /**
   * Answer `method` requests to `path`. A `:name` segment is a parameter
   * (percent-decoded, so it may contain `/`); a final `*` matches the rest. The
   * first match registered wins. No match is a 404 (`sandbox/public/404.html`
   * if it exists).
   * @example
   * server.route("GET", "/api/users/:id", async (request, { id }) => {
   *   const page = new URL(request.url).searchParams.get("page") ?? "1";
   *   return Response.json({ id, page });
   * });
   */
  route(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "*", path: string, handler: Handler): void;
}

/**
 * Standard `Request` in, standard `Response` out. A thrown error becomes a
 * logged 500; its message is sent only in dev and tests.
 *
 * Limits:
 * - Await everything before returning: work left running may be cut off.
 * - Cloudflare's free plan allows 10 ms of CPU per request (waiting is free).
 * - Client address: `request.headers.get("CF-Connecting-IP")`.
 * - A header sent twice arrives joined by ", ". Send several `Set-Cookie`
 *   with `headers.append`.
 * - If the client disconnects, Cloudflare may stop the handler; locally it finishes.
 */
export type Handler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;
