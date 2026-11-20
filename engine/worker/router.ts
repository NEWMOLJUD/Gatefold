import type { Handler, Server } from "../../deps/server.ts";

type Method = Parameters<Server["route"]>[0];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "*"];

interface Route {
  method: string;
  segments: string[];
  wildcard: boolean;
  handler: Handler;
}

export interface Match {
  handler: Handler;
  params: Record<string, string>;
}

export class Router {
  #routes: Route[] = [];

  add(method: Method, path: string, handler: Handler): void {
    if (!METHODS.includes(method)) {
      throw new TypeError(`server.route: unknown method "${method}". Use one of ${METHODS.join(", ")}.`);
    }
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError(`server.route: path must start with "/" (got ${JSON.stringify(path)}).`);
    }
    if (typeof handler !== "function") {
      throw new TypeError(`server.route: the handler for ${method} ${path} must be a function.`);
    }
    const segments = split(path);
    const wildcard = segments.at(-1) === "*";
    if (wildcard) segments.pop();
    if (segments.includes("*")) {
      throw new TypeError(`server.route: "*" is only allowed as the last segment (in ${path}).`);
    }
    this.#routes.push({ method, segments, wildcard, handler });
  }

  match(method: string, pathname: string): Match | undefined {
    const parts = split(pathname);
    const methods = method === "HEAD" ? ["HEAD", "GET"] : [method];
    for (const wanted of methods) {
      for (const route of this.#routes) {
        if (route.method !== "*" && route.method !== wanted) continue;
        const params = matchSegments(route, parts);
        if (params) return { handler: route.handler, params };
      }
    }
    return undefined;
  }
}

function split(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function matchSegments(route: Route, parts: string[]): Record<string, string> | undefined {
  if (parts.length < route.segments.length) return undefined;
  if (parts.length > route.segments.length && !route.wildcard) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const segment = route.segments[i]!;
    const part = parts[i]!;
    if (segment.startsWith(":")) params[segment.slice(1)] = decode(part);
    else if (segment !== part) return undefined;
  }
  if (route.wildcard) params["*"] = parts.slice(route.segments.length).map(decode).join("/");
  return params;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
