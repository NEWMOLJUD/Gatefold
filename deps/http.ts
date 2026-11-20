/** Outbound HTTP calls. */
export interface Http {
  /**
   * Same as the standard `fetch`. Limit: 50 calls per request on Cloudflare's
   * free plan. In tests the test answers it (testing.ts).
   * @example
   * const res = await http.fetch("https://api.example.com/items", {
   *   headers: { authorization: `Bearer ${secrets.get("EXAMPLE_KEY")}` },
   * });
   * if (!res.ok) throw new Error(`example.com answered ${res.status}`);
   * const items = (await res.json()) as { id: string }[];
   */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}
