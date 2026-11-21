// The settings a source carries among its own files, uploaded with its content:
//
//   source.json   { "render": ["html"], "props": { "title": "Handbook" } }
//
// `render` lists the file extensions that go through the template engine and
// `props` are the values its templates read. Who may read the source is not
// decided here: visibility and permissions belong to the administrator.
import type { Files } from "../deps/files.ts";

/** The prefix of every source file in the file storage: sources/<storage id>/<path>. */
export const SOURCES_FOLDER = "sources";

/** The settings file at the root of a source. It is never delivered to readers. */
export const SOURCE_CONFIG = "source.json";

/** Maximum size of a props JSON, in characters. */
export const MAX_PROPS = 64 * 1024;

const MAX_EXTENSIONS = 30;

export interface SourceConfig {
  /** Extensions rendered by the template engine. An empty list turns rendering off. */
  render: string[];
  props: Record<string, unknown>;
  /** What was wrong with the file, in words for whoever wrote it. Each problem falls back to the default of its key. */
  problems: string[];
}

/** What a source without a source.json gets. */
export const DEFAULT_RENDER: readonly string[] = ["html"];

function extensions(value: unknown, problems: string[]): string[] {
  if (value === undefined) return [...DEFAULT_RENDER];
  if (!Array.isArray(value)) {
    problems.push('"render" must be a list of extensions, for example ["html", "css"]. Using ["html"].');
    return [...DEFAULT_RENDER];
  }
  const list: string[] = [];
  for (const item of value) {
    const extension = typeof item === "string" ? item.replace(/^\./, "").toLowerCase() : "";
    if (!/^[a-z0-9]{1,10}$/.test(extension)) {
      problems.push(`"render" has an invalid extension: ${JSON.stringify(item)}. Use names such as "html" or "css". Using ["html"].`);
      return [...DEFAULT_RENDER];
    }
    if (!list.includes(extension)) list.push(extension);
  }
  if (list.length > MAX_EXTENSIONS) {
    problems.push(`"render" has too many extensions: the maximum is ${MAX_EXTENSIONS}. Using ["html"].`);
    return [...DEFAULT_RENDER];
  }
  return list;
}

function properties(value: unknown, problems: string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push('"props" must be a JSON object, for example {"theme": "dark"}. Using no props.');
    return {};
  }
  if (JSON.stringify(value).length > MAX_PROPS) {
    problems.push(`"props" exceed the maximum size (${MAX_PROPS} characters). Using no props.`);
    return {};
  }
  return value as Record<string, unknown>;
}

/** Turns the parsed content of a source.json into settings. Never throws: what is wrong becomes a problem and a default. */
export function parseSourceConfig(value: unknown): SourceConfig {
  const problems: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { render: [...DEFAULT_RENDER], props: {}, problems: ['The file must hold a JSON object, for example {"render": ["html"], "props": {}}.'] };
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (key !== "render" && key !== "props") problems.push(`Unknown key ${JSON.stringify(key)}: it is ignored. Only "render" and "props" are read.`);
  }
  return { render: extensions(config.render, problems), props: properties(config.props, problems), problems };
}

/** Reads the source.json stored under `key`, or `null` when it is not there. */
export async function loadSourceConfig(files: Files, key: string): Promise<SourceConfig | null> {
  const file = await files.get(key);
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return { render: [...DEFAULT_RENDER], props: {}, problems: ["The file is not valid JSON, so the defaults are in use: only html is rendered, with no props."] };
  }
  return parseSourceConfig(parsed);
}
