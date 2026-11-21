/** Read-only secrets (API keys, tokens). Only the user sets them. */
export interface Secrets {
  /**
   * The value of secret `name`. Throws if it is not set, with an error that
   * tells the user how to set it. Call it inside the route or job that needs
   * it, so a missing secret breaks only that route.
   * @example
   * const key = secrets.get("RESEND_API_KEY");
   */
  get(name: string): string;
}
