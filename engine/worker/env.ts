import type { Database } from "./databases.ts";

/** Bindings declared by the generated Wrangler config, plus the user's secrets. */
export interface Env {
  DB: DurableObjectNamespace<Database>;
  /** Present only when the app uses `deps.files`. */
  FILES?: R2Bucket;
  /** Present when `sandbox/public/` exists. */
  ASSETS?: Fetcher;
  /** Worker name, for messages that point at the dashboard. */
  REDOMA_NAME?: string;
  /** "dev" under `npm run dev` and tests: error messages are sent to the client. */
  REDOMA_MODE?: string;
  /** Token the local runner uses for its control routes. Never set on Cloudflare. */
  REDOMA_CONTROL?: string;
  /** Where the test runner answers mocked `deps.http.fetch` calls. */
  REDOMA_TEST_HTTP?: string;
  /** "1" behind the Linux front door, which reports the real scheme. */
  REDOMA_FRONT?: string;
  [name: string]: unknown;
}

/** An error whose message is safe and useful to show to whoever made the request. */
export class PublicError extends Error {
  override name = "Error";
}
