// Canone's template engine. Liquid-style syntax, interpreted step by step:
// nothing here generates or executes code.
//
//   {{ props.site }}                      prints, escaping HTML
//   {{ props.html | raw }}                prints without escaping
//   {{ props | json }}                    prints as JSON, safe inside <script>
//   {% if a >= 18 and b %}..{% elsif c %}..{% else %}..{% endif %}
//   {% for item in props.items %}..{% else %}..{% endfor %}
//   {% raw %}..{% endraw %}               left as written, not interpreted
//   {% comment %}..{% endcomment %}       dropped from the output

export class TemplateError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.line = line;
  }
}

type Expr =
  | { kind: "literal"; value: unknown }
  | { kind: "path"; root: string; steps: (string | Expr)[] }
  | { kind: "not"; operand: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr };

interface Filter {
  name: string;
  args: Expr[];
}

type Node =
  | { kind: "text"; text: string }
  | { kind: "output"; expr: Expr; filters: Filter[]; line: number }
  | { kind: "if"; branches: { test: Expr | null; body: Node[] }[] }
  | { kind: "for"; name: string; list: Expr; body: Node[]; empty: Node[]; line: number };

/** Step ceiling for one render: a loop inside a loop must not hang the server. */
const MAX_STEPS = 200_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_DEPTH = 40;

export function render(source: string, scope: Record<string, unknown>): string {
  const nodes = parse(source);
  const state = { steps: 0, size: 0 };
  const out: string[] = [];
  run(nodes, [scope], out, state);
  return out.join("");
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Piece =
  | { kind: "text"; text: string }
  | { kind: "output"; code: string; line: number }
  | { kind: "tag"; name: string; rest: string; line: number };

function scan(source: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  let line = 1;
  const text = (upTo: number): void => {
    if (upTo > at) pieces.push({ kind: "text", text: source.slice(at, upTo) });
  };
  const countLines = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (source.charCodeAt(i) === 10) line++;
  };
  while (at < source.length) {
    const open = nextOpen(source, at);
    if (open < 0) break;
    countLines(at, open);
    text(open);
    const isOutput = source[open + 1] === "{";
    const close = source.indexOf(isOutput ? "}}" : "%}", open + 2);
    if (close < 0) throw new TemplateError(`"${isOutput ? "{{" : "{%"}" is never closed`, line);
    const code = source.slice(open + 2, close).trim();
    const startLine = line;
    countLines(open, close + 2);
    at = close + 2;
    if (isOutput) {
      pieces.push({ kind: "output", code, line: startLine });
      continue;
    }
    const name = /^[a-z]+/.exec(code)?.[0] ?? "";
    if (name === "raw" || name === "comment") {
      const end = new RegExp(`\\{%\\s*end${name}\\s*%\\}`, "g");
      end.lastIndex = at;
      const found = end.exec(source);
      if (!found) throw new TemplateError(`"{% ${name} %}" without "{% end${name} %}"`, startLine);
      if (name === "raw") pieces.push({ kind: "text", text: source.slice(at, found.index) });
      countLines(at, found.index + found[0].length);
      at = found.index + found[0].length;
      continue;
    }
    pieces.push({ kind: "tag", name, rest: code.slice(name.length).trim(), line: startLine });
  }
  text(source.length);
  return pieces;
}

function nextOpen(source: string, from: number): number {
  for (let i = source.indexOf("{", from); i >= 0; i = source.indexOf("{", i + 1)) {
    const next = source[i + 1];
    if (next === "{" || next === "%") return i;
  }
  return -1;
}

function parse(source: string): Node[] {
  const pieces = scan(source);
  let at = 0;

  /** Reads nodes until one of the `until` tags, which is left for the caller. */
  const block = (until: string[], opener: string, line: number, depth: number): Node[] => {
    if (depth > MAX_DEPTH) throw new TemplateError("blocks nested too deep", line);
    const nodes: Node[] = [];
    while (at < pieces.length) {
      const piece = pieces[at]!;
      if (piece.kind === "text") {
        nodes.push(piece);
        at++;
      } else if (piece.kind === "output") {
        nodes.push(parseOutput(piece.code, piece.line));
        at++;
      } else if (until.includes(piece.name)) {
        return nodes;
      } else if (piece.name === "if") {
        at++;
        const branches: { test: Expr | null; body: Node[] }[] = [];
        let test: Expr | null = parseExpression(piece.rest, piece.line);
        for (;;) {
          const body = block(["elsif", "else", "endif"], "if", piece.line, depth + 1);
          branches.push({ test, body });
          const end = pieces[at++] as Extract<Piece, { kind: "tag" }>;
          if (end.name === "endif") break;
          if (test === null) throw new TemplateError(`"{% ${end.name} %}" after "{% else %}"`, end.line);
          test = end.name === "elsif" ? parseExpression(end.rest, end.line) : null;
        }
        nodes.push({ kind: "if", branches });
      } else if (piece.name === "for") {
        at++;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/s.exec(piece.rest);
        if (!match) throw new TemplateError('invalid loop: use "{% for item in list %}"', piece.line);
        const list = parseExpression(match[2]!, piece.line);
        const body = block(["else", "endfor"], "for", piece.line, depth + 1);
        let empty: Node[] = [];
        if ((pieces[at++] as Extract<Piece, { kind: "tag" }>).name === "else") {
          empty = block(["endfor"], "for", piece.line, depth + 1);
          at++;
        }
        nodes.push({ kind: "for", name: match[1]!, list, body, empty, line: piece.line });
      } else {
        throw new TemplateError(`unknown or misplaced tag: "{% ${piece.name || piece.rest} %}"`, piece.line);
      }
    }
    if (until.length > 0) throw new TemplateError(`"{% ${opener} %}" without "{% end${opener} %}"`, line);
    return nodes;
  };

  return block([], "", 1, 0);
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

type Token = { type: "name" | "string" | "number" | "op"; value: string };

const TOKEN = /\s*(?:("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_-]*)|(==|!=|<=|>=|[<>()[\].|:,]))/y;

function tokenize(code: string, line: number): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < code.length) {
    if (code.slice(at).trim() === "") break;
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(code);
    if (!match) throw new TemplateError(`invalid expression: "${code}"`, line);
    at = TOKEN.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: "string", value: match[1].slice(1, -1).replace(/\\(.)/g, "$1") });
    else if (match[2] !== undefined) tokens.push({ type: "number", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ type: "name", value: match[3] });
    else tokens.push({ type: "op", value: match[4]! });
  }
  return tokens;
}

const COMPARISONS = new Set(["==", "!=", "<", ">", "<=", ">=", "contains"]);

class ExpressionParser {
  #tokens: Token[];
  #at = 0;
  #line: number;
  #code: string;

  constructor(code: string, line: number) {
    this.#tokens = tokenize(code, line);
    this.#line = line;
    this.#code = code;
  }

  fail(): never {
    throw new TemplateError(`invalid expression: "${this.#code}"`, this.#line);
  }

  peek(): Token | undefined {
    return this.#tokens[this.#at];
  }

  done(): boolean {
    return this.#at >= this.#tokens.length;
  }

  is(type: Token["type"], value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.type === type && token.value === value;
  }

  take(type: Token["type"], value: string): boolean {
    if (!this.is(type, value)) return false;
    this.#at++;
    return true;
  }

  or(): Expr {
    let left = this.and();
    while (this.take("name", "or")) left = { kind: "binary", op: "or", left, right: this.and() };
    return left;
  }

  and(): Expr {
    let left = this.not();
    while (this.take("name", "and")) left = { kind: "binary", op: "and", left, right: this.not() };
    return left;
  }

  not(): Expr {
    if (this.take("name", "not")) return { kind: "not", operand: this.not() };
    return this.comparison();
  }

  comparison(): Expr {
    const left = this.primary();
    const token = this.peek();
    if (token && (token.type === "op" || token.value === "contains") && COMPARISONS.has(token.value)) {
      this.#at++;
      return { kind: "binary", op: token.value, left, right: this.primary() };
    }
    return left;
  }

  primary(): Expr {
    const token = this.peek();
    if (!token) this.fail();
    this.#at++;
    if (token.type === "string") return { kind: "literal", value: token.value };
    if (token.type === "number") return { kind: "literal", value: Number(token.value) };
    if (token.type === "op") {
      if (token.value !== "(") this.fail();
      const inner = this.or();
      if (!this.take("op", ")")) this.fail();
      return inner;
    }
    if (token.value === "true") return { kind: "literal", value: true };
    if (token.value === "false") return { kind: "literal", value: false };
    if (token.value === "nil" || token.value === "null") return { kind: "literal", value: null };
    const steps: (string | Expr)[] = [];
    for (;;) {
      if (this.take("op", ".")) {
        const step = this.peek();
        if (!step || (step.type !== "name" && step.type !== "number")) this.fail();
        this.#at++;
        steps.push(step.value);
      } else if (this.take("op", "[")) {
        steps.push(this.or());
        if (!this.take("op", "]")) this.fail();
      } else {
        return { kind: "path", root: token.value, steps };
      }
    }
  }
}

function parseExpression(code: string, line: number): Expr {
  const parser = new ExpressionParser(code, line);
  const expr = parser.or();
  if (!parser.done()) parser.fail();
  return expr;
}

const FILTERS = new Set(["raw", "json", "upper", "lower", "default", "size"]);

function parseOutput(code: string, line: number): Node {
  const parser = new ExpressionParser(code, line);
  const expr = parser.or();
  const filters: Filter[] = [];
  while (parser.take("op", "|")) {
    const name = parser.peek();
    if (!name || name.type !== "name" || !FILTERS.has(name.value)) {
      throw new TemplateError(`unknown filter in "{{ ${code} }}". Available: ${[...FILTERS].join(", ")}`, line);
    }
    parser.take("name", name.value);
    const args: Expr[] = [];
    if (parser.take("op", ":")) {
      do args.push(parser.primary());
      while (parser.take("op", ","));
    }
    filters.push({ name: name.value, args });
  }
  if (!parser.done()) parser.fail();
  return { kind: "output", expr, filters, line };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Scopes = Record<string, unknown>[];
interface State {
  steps: number;
  size: number;
}

function run(nodes: Node[], scopes: Scopes, out: string[], state: State): void {
  for (const node of nodes) {
    if (++state.steps > MAX_STEPS) throw new TemplateError("the template exceeded the step limit (a loop that is too large?)", 0);
    if (node.kind === "text") {
      emit(node.text, out, state);
    } else if (node.kind === "output") {
      emit(output(node, scopes), out, state);
    } else if (node.kind === "if") {
      const branch = node.branches.find((candidate) => candidate.test === null || truthy(evaluate(candidate.test, scopes)));
      if (branch) run(branch.body, scopes, out, state);
    } else {
      const items = toList(evaluate(node.list, scopes));
      if (items.length === 0) {
        run(node.empty, scopes, out, state);
        continue;
      }
      items.forEach((item, index) => {
        const forloop = { index: index + 1, index0: index, first: index === 0, last: index === items.length - 1, length: items.length };
        run(node.body, [...scopes, { [node.name]: item, forloop }], out, state);
      });
    }
  }
}

function emit(text: string, out: string[], state: State): void {
  state.size += text.length;
  if (state.size > MAX_OUTPUT) throw new TemplateError("the rendered page exceeded the maximum size", 0);
  out.push(text);
}

function output(node: Extract<Node, { kind: "output" }>, scopes: Scopes): string {
  let value = evaluate(node.expr, scopes);
  let escape = true;
  for (const filter of node.filters) {
    if (filter.name === "raw") escape = false;
    else if (filter.name === "json") {
      // "<" is escaped: the result can sit inside <script> without closing the tag.
      value = (JSON.stringify(value ?? null) ?? "null").replace(/</g, "\\u003c");
      escape = false;
    } else if (filter.name === "upper") value = text(value).toUpperCase();
    else if (filter.name === "lower") value = text(value).toLowerCase();
    else if (filter.name === "size") value = typeof value === "string" ? value.length : toList(value).length;
    else if (filter.name === "default") {
      if (value === null || value === undefined || value === "" || value === false) {
        value = filter.args[0] ? evaluate(filter.args[0], scopes) : "";
      }
    }
  }
  const printed = text(value);
  return escape ? escapeHtml(printed) : printed;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false && value !== "" && value !== 0;
}

function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).map((key) => ({ key, value: (value as Record<string, unknown>)[key] }));
  }
  return [];
}

/** Own properties of objects and arrays only: never prototypes, never functions. */
function member(target: unknown, key: unknown): unknown {
  if (target === null || target === undefined) return undefined;
  if (Array.isArray(target)) {
    if (key === "size" || key === "length") return target.length;
    if (key === "first") return target[0];
    if (key === "last") return target[target.length - 1];
    const index = typeof key === "number" ? key : typeof key === "string" && /^\d+$/.test(key) ? Number(key) : -1;
    return Number.isInteger(index) && index >= 0 ? target[index] : undefined;
  }
  if (typeof target === "string") return key === "size" || key === "length" ? target.length : undefined;
  if (typeof target !== "object") return undefined;
  const name = typeof key === "number" ? String(key) : key;
  if (typeof name !== "string" || !Object.hasOwn(target, name)) return undefined;
  const found = (target as Record<string, unknown>)[name];
  return typeof found === "function" ? undefined : found;
}

function evaluate(expr: Expr, scopes: Scopes): unknown {
  if (expr.kind === "literal") return expr.value;
  if (expr.kind === "not") return !truthy(evaluate(expr.operand, scopes));
  if (expr.kind === "path") {
    let value: unknown;
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (Object.hasOwn(scopes[i]!, expr.root)) {
        value = scopes[i]![expr.root];
        break;
      }
    }
    for (const step of expr.steps) value = member(value, typeof step === "string" ? step : evaluate(step, scopes));
    return value;
  }
  if (expr.op === "and") return truthy(evaluate(expr.left, scopes)) && truthy(evaluate(expr.right, scopes));
  if (expr.op === "or") return truthy(evaluate(expr.left, scopes)) || truthy(evaluate(expr.right, scopes));
  const left = evaluate(expr.left, scopes);
  const right = evaluate(expr.right, scopes);
  if (expr.op === "contains") {
    if (typeof left === "string") return typeof right === "string" && left.includes(right);
    return Array.isArray(left) && left.some((item) => same(item, right));
  }
  if (expr.op === "==") return same(left, right);
  if (expr.op === "!=") return !same(left, right);
  const [a, b] = comparable(left, right);
  if (a === undefined || b === undefined) return false;
  if (expr.op === "<") return a < b;
  if (expr.op === ">") return a > b;
  if (expr.op === "<=") return a <= b;
  return a >= b;
}

function same(left: unknown, right: unknown): boolean {
  if ((left === null || left === undefined) && (right === null || right === undefined)) return true;
  const [a, b] = comparable(left, right);
  return a !== undefined && a === b;
}

/** Numbers compare with numbers; a numeric string (query, header) becomes a number when compared with one. */
function comparable(left: unknown, right: unknown): [number, number] | [string, string] | [boolean, boolean] | [undefined, undefined] {
  if (typeof left === "number" && typeof right === "number") return [left, right];
  if (typeof left === "string" && typeof right === "string") return [left, right];
  if (typeof left === "boolean" && typeof right === "boolean") return [left, right];
  if (typeof left === "number" && typeof right === "string" && isNumeric(right)) return [left, Number(right)];
  if (typeof left === "string" && typeof right === "number" && isNumeric(left)) return [Number(left), right];
  return [undefined, undefined];
}

function isNumeric(value: string): boolean {
  return /^\s*-?\d+(\.\d+)?\s*$/.test(value);
}
