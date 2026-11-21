// deps.files on R2. Locally Miniflare keeps the objects on disk.
import type { Files } from "../../deps/files.ts";
import { type Env, PublicError } from "./env.ts";

type FileBody = Parameters<Files["put"]>[1];
type FileInfo = Awaited<ReturnType<Files["list"]>>[number];

/** `prefix` keeps the files of each test app apart; it is empty for the real app. */
export function createFiles(env: Env, prefix: string): Files {
  const bucket = (): R2Bucket => {
    if (env.FILES) return env.FILES;
    throw new PublicError(
      "deps.files is not switched on for this deployment yet. On your computer run `npm run test` " +
        "(it updates wrangler.jsonc), commit the change and publish again. " +
        "The Cloudflare account also needs R2 enabled: dashboard → R2 → follow the one-time setup.",
    );
  };

  const full = (method: string, key: string): string => {
    if (typeof key !== "string" || key === "" || key.length > 900) {
      throw new TypeError(`files.${method}: the key must be a non-empty string of at most 900 characters (got ${JSON.stringify(key)}).`);
    }
    return prefix + key;
  };

  return {
    async put(key: string, body: FileBody, contentType?: string): Promise<void> {
      const name = full("put", key);
      const options = contentType ? { httpMetadata: { contentType } } : undefined;
      if (body instanceof ReadableStream) {
        try {
          await bucket().put(name, body, options);
          return;
        } catch (error) {
          // R2 refuses streams of unknown length. Buffer and retry.
          if (!(error instanceof TypeError) || !/known length/i.test(error.message) || body.locked) throw error;
          body = await new Response(body).arrayBuffer();
        }
      }
      await bucket().put(name, body as ArrayBuffer | ArrayBufferView | string | Blob, options);
    },

    async get(key: string): Promise<Response | null> {
      const object = await bucket().get(full("get", key));
      if (!object) return null;
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
      headers.set("etag", object.httpEtag);
      headers.set("last-modified", object.uploaded.toUTCString());
      // A stream of declared length makes the runtime send Content-Length instead of chunking.
      return new Response(object.body.pipeThrough(new FixedLengthStream(object.size)), { headers });
    },

    async delete(key: string): Promise<void> {
      await bucket().delete(full("delete", key));
    },

    async list(listPrefix = ""): Promise<FileInfo[]> {
      if (typeof listPrefix !== "string") throw new TypeError("files.list: the prefix must be a string.");
      const found: FileInfo[] = [];
      let cursor: string | undefined;
      // One R2 page may hold fewer than 1000 entries: keep reading until full or done.
      while (found.length < 1000) {
        const page = await bucket().list({ prefix: prefix + listPrefix, limit: 1000 - found.length, cursor });
        for (const object of page.objects) {
          found.push({ key: object.key.slice(prefix.length), size: object.size, uploaded: object.uploaded });
        }
        if (!page.truncated) break;
        cursor = page.cursor;
      }
      return found;
    },
  };
}
