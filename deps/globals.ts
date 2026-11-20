/**
 * Web globals the sandbox may use directly, besides the JavaScript language
 * (`JSON`, `Math`, `Date`...). In restrict mode nothing else exists: no `fetch`
 * (use `deps.http`), no `process`, no `globalThis`.
 */
export type Globals =
  | "Request" | "Response" | "Headers" | "URL" | "URLSearchParams" | "FormData" | "Blob" | "File"
  | "ReadableStream" | "WritableStream" | "TransformStream" | "TextEncoder" | "TextDecoder"
  | "AbortController" | "AbortSignal" | "crypto" | "console" | "setTimeout" | "clearTimeout"
  | "structuredClone" | "atob" | "btoa";
