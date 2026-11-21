// deps.sites: the repository's sites/ folder, uploaded as the Worker's static
// assets with `run_worker_first`, so the only way to a file is this module.
import folders from "../../.wrangler/redoma/sites.ts";
import type { Sites } from "../../deps/sites.ts";
import type { Env } from "./env.ts";

export function createSites(env: Env): Sites {
  return {
    folders(parent: string = ""): string[] {
      if (typeof parent !== "string") throw new TypeError(`sites.folders: the parent must be a string (got ${typeof parent}).`);
      return Object.hasOwn(folders, parent) ? [...folders[parent]!] : [];
    },

    async get(path: string): Promise<Response | null> {
      if (typeof path !== "string") throw new TypeError(`sites.get: the path must be a string (got ${typeof path}).`);
      if (!env.SITES || path === "" || path.length > 1024 || path.includes("\\")) return null;
      const segments = path.split("/");
      if (segments.some((segment) => segment === "" || segment.startsWith("."))) return null;
      const url = `http://sites/${segments.map(encodeURIComponent).join("/")}`;
      const found = await env.SITES.fetch(new Request(url));
      if (found.status !== 200) {
        await found.body?.cancel();
        return null;
      }
      const headers = new Headers({ "content-type": found.headers.get("content-type") ?? "application/octet-stream" });
      const etag = found.headers.get("etag");
      if (etag) headers.set("etag", etag);
      return new Response(found.body, { headers });
    },
  };
}
