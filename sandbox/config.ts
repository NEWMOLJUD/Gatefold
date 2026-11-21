// What an installation says about where it runs: the optional file
// sites/gatefold.json. It is content, published with the sites, and never
// served to anyone.
//
//   {
//     "client_ip": "cloudflare",
//     "public_url": "https://pages.example.com"
//   }
//
// Neither key is a secret, and both have a default that is right on
// Cloudflare. They matter on a Linux server behind a reverse proxy, where the
// app sees the proxy's address and plain HTTP instead of the visitor's.
import type { Sites } from "../deps/sites.ts";

export const CONFIG_FILE = "gatefold.json";

/** Where the visitor's address comes from. Only one source is ever trusted. */
export const CLIENT_IP_SOURCES = ["cloudflare", "x-forwarded-for", "x-real-ip", "none"] as const;
export type ClientIpSource = (typeof CLIENT_IP_SOURCES)[number];

export interface Config {
  /**
   * "cloudflare": the `CF-Connecting-IP` header, which Cloudflare sets and a
   * visitor cannot. "x-forwarded-for" and "x-real-ip": the header a reverse
   * proxy in front of a Linux server sets. "none": addresses are not recorded.
   * A header nothing in front of the app sets can be written by anyone, so on
   * a server reached directly this must be "none".
   */
  client_ip: ClientIpSource;
  /** The address people type to reach the installation ("https://pages.example.com"), when the app cannot see it by itself. */
  public_url: string | null;
  /** What is wrong with the file, if anything. A wrong key falls back to its default. */
  problems: string[];
}

export const DEFAULT_CONFIG: Config = { client_ip: "cloudflare", public_url: null, problems: [] };

export function parseConfig(value: unknown): Config {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_CONFIG, problems: [`${CONFIG_FILE} must hold a JSON object.`] };
  }
  const input = value as Record<string, unknown>;
  const config: Config = { ...DEFAULT_CONFIG, problems: [] };
  if (input.client_ip !== undefined) {
    if (CLIENT_IP_SOURCES.includes(input.client_ip as ClientIpSource)) config.client_ip = input.client_ip as ClientIpSource;
    else config.problems.push(`"client_ip" must be one of: ${CLIENT_IP_SOURCES.join(", ")}.`);
  }
  if (input.public_url !== undefined && input.public_url !== null && input.public_url !== "") {
    let url: URL | null = null;
    try {
      url = typeof input.public_url === "string" ? new URL(input.public_url) : null;
    } catch {
      url = null;
    }
    if (url && (url.protocol === "https:" || url.protocol === "http:")) config.public_url = url.origin;
    else config.problems.push('"public_url" must be an address such as "https://pages.example.com".');
  }
  for (const key of Object.keys(input)) {
    if (key !== "client_ip" && key !== "public_url") config.problems.push(`"${key}" is not a setting of ${CONFIG_FILE}.`);
  }
  return config;
}

// The file is part of the publication: it cannot change while the app runs.
const loaded = new WeakMap<Sites, Promise<Config>>();

export function loadConfig(sites: Sites): Promise<Config> {
  let config = loaded.get(sites);
  if (!config) {
    config = (async () => {
      const file = await sites.get(CONFIG_FILE);
      if (!file) return DEFAULT_CONFIG;
      try {
        return parseConfig(JSON.parse(await file.text()));
      } catch {
        return { ...DEFAULT_CONFIG, problems: [`${CONFIG_FILE} is not valid JSON.`] };
      }
    })();
    loaded.set(sites, config);
  }
  return config;
}

/** The visitor's address, from the one source the installation trusts. */
export function clientIp(request: Request, config: Config): string | null {
  let value: string | null = null;
  if (config.client_ip === "cloudflare") value = request.headers.get("cf-connecting-ip");
  else if (config.client_ip === "x-real-ip") value = request.headers.get("x-real-ip");
  else if (config.client_ip === "x-forwarded-for") {
    // Each proxy appends the address it saw: the last one was written by the proxy in front of the app, the others by whoever sent the request.
    value = (request.headers.get("x-forwarded-for") ?? "").split(",").at(-1) ?? null;
  }
  value = value?.trim() ?? "";
  return /^[0-9A-Fa-f:.]{2,64}$/.test(value) ? value : null;
}

/** The origin people reach the installation by ("https://pages.example.com"). */
export function publicOrigin(request: Request, config: Config): string {
  return config.public_url ?? new URL(request.url).origin;
}

/**
 * Protection against requests forged by another site (CSRF): a change made
 * with a cookie only counts if the browser says it came from this site.
 */
export function sameOrigin(request: Request, config: Config): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === new URL(request.url).origin || origin === config.public_url;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

// ---------------------------------------------------------------------------
// Headers every answer carries
// ---------------------------------------------------------------------------

/** Six months. No `includeSubDomains`: the installation does not speak for the other names of its domain. */
const HSTS = "max-age=15552000";

/**
 * Adds what an answer is missing. Each page and file sets the policy that
 * fits it; this is the floor for everything else (JSON, redirects, errors).
 */
export function withHeaders(request: Request, response: Response, config: Config): Response {
  let answer = response;
  try {
    answer.headers.set("x-content-type-options", "nosniff");
  } catch {
    // An answer whose headers are locked: the same answer, with headers that can be set.
    answer = new Response(response.body, response);
    answer.headers.set("x-content-type-options", "nosniff");
  }
  const headers = answer.headers;
  if (publicOrigin(request, config).startsWith("https:")) headers.set("strict-transport-security", HSTS);
  const type = (headers.get("content-type") ?? "").toLowerCase();
  if (!headers.has("content-security-policy") && (type === "" || type.startsWith("application/json") || type.startsWith("text/plain") || type.startsWith("text/csv"))) {
    // Data, not a page: nothing in it may run, load or be framed.
    headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  }
  if (!headers.has("referrer-policy")) headers.set("referrer-policy", "no-referrer");
  return answer;
}
