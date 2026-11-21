// Static analysis of the project with the TypeScript compiler: type errors,
// which capabilities the sandbox uses, and the restrict-mode gates.
//
// This is the only file that talks to the TypeScript API. TypeScript 7 exposes
// it under `typescript/unstable/*`, so package.json pins the exact version;
// when the template moves to a newer TypeScript, this file moves with it.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { DEPS, type Problem, ROOT, SANDBOX, rel } from "./cli.ts";

type Api = typeof import("typescript/unstable/sync");
type Ast = typeof import("typescript/unstable/ast");
type Node = import("typescript/unstable/ast").Node;
type SourceFile = import("typescript/unstable/ast").SourceFile;
type Project = import("typescript/unstable/sync").Project;
type Diagnostic = import("typescript/unstable/sync").Diagnostic;

export interface AnalyzeOptions {
  /** Report type errors of the Worker program (sandbox, deps, engine/worker). */
  types: boolean;
  /** Also type-check the Node side (engine/tools, scripts). */
  tools: boolean;
  /** Run the restrict-mode gates on the sandbox. */
  restricted: boolean;
}

export interface Analysis {
  problems: Problem[];
  /** Capabilities the sandbox refers to, found through the type checker. */
  uses: { files: boolean; cron: boolean };
}

/** Names that reach arbitrary code or the global object, whatever they resolve to. */
const BANNED = new Set(["eval", "Function", "globalThis", "self", "global", "window", "require"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export async function analyze(options: AnalyzeOptions): Promise<Analysis> {
  let sync: Api;
  let ast: Ast;
  try {
    sync = await import("typescript/unstable/sync");
    ast = await import("typescript/unstable/ast");
  } catch (error) {
    throw new Error(
      `Cannot load the TypeScript compiler API (${error instanceof Error ? error.message : error}). ` +
        "Run `npm install` to get the exact TypeScript version this project is pinned to.",
    );
  }
  const api = new sync.API({ cwd: ROOT });
  try {
    const problems: Problem[] = [];
    const worker = open(api, join(ROOT, "tsconfig.json"));
    if (options.types) problems.push(...diagnostics(worker));
    const sandboxFiles = worker.program.getSourceFileNames().filter((name) => inside(name, SANDBOX));
    const uses = findUses(ast, worker, sandboxFiles);
    if (options.restricted) problems.push(...gates(ast, worker, sandboxFiles));
    if (options.tools) problems.push(...diagnostics(open(api, join(ROOT, "engine", "tsconfig.json"))));
    return { problems: dedupe(problems), uses };
  } finally {
    api.close();
  }
}

function open(api: InstanceType<Api["API"]>, config: string): Project {
  const snapshot = api.updateSnapshot({ openProject: config });
  const project = snapshot.getProject(config) ?? snapshot.getProjects()[0];
  if (!project) throw new Error(`TypeScript could not load ${rel(config)}.`);
  return project;
}

function diagnostics(project: Project): Problem[] {
  const { program } = project;
  const all: Diagnostic[] = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getProgramDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  const problems: Problem[] = [];
  for (const diagnostic of all) {
    if (diagnostic.category !== 1 /* error */) continue;
    const file = diagnostic.fileName;
    if (file && file.includes(`${sep}node_modules${sep}`)) continue;
    const source = file ? program.getSourceFile(file) : undefined;
    const at = source?.getLineAndCharacterOfPosition(diagnostic.pos);
    problems.push({
      file: file ? rel(file) : rel(project.configFileName),
      line: at ? at.line + 1 : 0,
      column: at ? at.character + 1 : 0,
      message: `${flatten(diagnostic)} (TS${diagnostic.code})`,
    });
  }
  return problems;
}

function flatten(diagnostic: Diagnostic): string {
  let text = diagnostic.text;
  let chain = diagnostic.messageChain;
  // The last link of a chain is usually the concrete reason: show first and last.
  while (chain && chain.length > 0) {
    const next: Diagnostic = chain[0]!;
    if (!next.messageChain || next.messageChain.length === 0) text += ` ${next.text}`;
    chain = next.messageChain;
  }
  return text.replace(/\s+/g, " ");
}

/** Does the sandbox touch `deps.files` or `deps.cron`? Asked of the type checker, so renames and destructuring count. */
function findUses(ast: Ast, project: Project, sandboxFiles: readonly string[]): Analysis["uses"] {
  const uses = { files: false, cron: false };
  const index = project.program.getSourceFile(join(DEPS, "index.ts"));
  if (!index) return uses;
  for (const statement of index.statements) {
    if (!ast.isInterfaceDeclaration(statement) || statement.name.text !== "Deps") continue;
    for (const member of statement.members) {
      if (!ast.isPropertySignatureDeclaration(member) || !ast.isIdentifier(member.name)) continue;
      const name = member.name.text;
      if (name !== "files" && name !== "cron") continue;
      const symbol = project.checker.getSymbolAtLocation(member.name);
      if (!symbol) continue;
      uses[name] = sandboxFiles.some(
        (file) => project.checker.getReferencesToSymbolInFile(file, symbol).length > 0 || destructures(ast, project, file, name, symbol.id),
      );
    }
  }
  return uses;
}

/** `const { files } = deps` and `function main({ files }: Deps)`: shorthand destructuring is a use too. */
function destructures(ast: Ast, project: Project, file: string, name: string, symbolId: number): boolean {
  const source = project.program.getSourceFile(file);
  let found = false;
  const visit = (node: Node): void => {
    if (found) return;
    if (ast.isBindingElement(node) && !node.propertyName && node.name && ast.isIdentifier(node.name) && node.name.text === name) {
      const type = project.checker.getTypeAtLocation(node.parent);
      const property = type ? project.checker.getPropertyOfType(type, name) : undefined;
      if (property?.id === symbolId) found = true;
    }
    node.forEachChild(visit);
  };
  if (source) visit(source);
  return found;
}

// ---------------------------------------------------------------------------
// Restrict mode
// ---------------------------------------------------------------------------

function gates(ast: Ast, project: Project, sandboxFiles: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  const allowed = allowedGlobals(ast, project);

  // Code the type checker does not see could carry anything: refuse it.
  for (const file of listCode(SANDBOX)) {
    const extension = extname(file);
    if (extension === ".ts" && !file.endsWith(".d.ts")) continue;
    problems.push({
      file: rel(file),
      line: 0,
      column: 0,
      message: `restrict mode: sandbox code must be plain .ts files (found a ${file.endsWith(".d.ts") ? ".d.ts" : extension} file). Rename or remove it.`,
    });
  }

  for (const name of sandboxFiles) {
    const source = project.program.getSourceFile(name);
    if (!source || name.endsWith(".d.ts")) continue;
    const report = (node: Node, message: string): void => {
      const at = source.getLineAndCharacterOfPosition(node.getStart(source));
      problems.push({ file: rel(name), line: at.line + 1, column: at.character + 1, message: `restrict mode: ${message}` });
    };
    const visit = (node: Node): void => {
      // Types cannot do anything at runtime: skip them.
      if (node.kind >= ast.SyntaxKind.FirstTypeNode && node.kind <= ast.SyntaxKind.LastTypeNode) return;
      if (ast.isInterfaceDeclaration(node) || ast.isTypeAliasDeclaration(node)) return;

      if (ast.isImportDeclaration(node) || ast.isExportDeclaration(node)) {
        if (node.moduleSpecifier) checkSpecifier(ast, name, node.moduleSpecifier, report);
        return;
      }
      if (ast.isImportEqualsDeclaration(node)) {
        report(node, "`import x = require(...)` is not allowed. Use a normal import of a file in sandbox/ or deps/.");
        return;
      }
      if (ast.isCallExpression(node) && node.expression.kind === ast.SyntaxKind.ImportKeyword) {
        report(node, "dynamic import() is not allowed. Use a static import at the top of the file.");
      }
      if (hasDeclare(ast, node)) {
        report(node, "`declare` is not allowed: it would make a hidden global look legitimate. Use what `deps` provides.");
        return;
      }
      if ((ast.isPropertyAccessExpression(node) && node.name.text === "constructor") || isConstructorIndex(ast, node)) {
        report(node, "`.constructor` is not allowed: it can be used to reach `Function` and run arbitrary code.");
      }
      if (ast.isIdentifier(node)) checkIdentifier(ast, project, node, allowed, report);
      node.forEachChild(visit);
    };
    visit(source);
  }
  return problems;
}

/** A sandbox file may import only files inside sandbox/ and deps/. */
function checkSpecifier(ast: Ast, file: string, specifier: Node, report: (node: Node, message: string) => void): void {
  if (!ast.isStringLiteral(specifier)) return;
  const text = specifier.text;
  if (!text.startsWith("./") && !text.startsWith("../")) {
    report(
      specifier,
      `import of "${text}" is not allowed. The sandbox may import only its own files and deps/. ` +
        (text === "node:fs" || text.startsWith("node:") || text.startsWith("cloudflare:")
          ? "Use the capabilities in `deps` instead."
          : "npm packages are off while restrict mode is on; ask the user to run `npm run restrict off` if this package is really needed."),
    );
    return;
  }
  const target = resolve(dirname(file), text);
  if (!inside(target, SANDBOX) && !inside(target, DEPS)) {
    report(specifier, `import of "${text}" reaches outside the sandbox (${rel(target)}). The sandbox may import only its own files and deps/.`);
  }
}

function checkIdentifier(
  ast: Ast,
  project: Project,
  node: import("typescript/unstable/ast").Identifier,
  allowed: Set<string>,
  report: (node: Node, message: string) => void,
): void {
  const parent = node.parent;
  if (isLabel(ast, node, parent)) return;

  const symbol = ast.isShorthandPropertyAssignment(parent)
    ? project.checker.getShorthandAssignmentValueSymbol(parent)
    : project.checker.getSymbolAtLocation(node);
  const declaredAt = symbol ? symbol.declarations.map((declaration) => String(declaration.path)) : [];
  // Declared by the sandbox itself: a local, a parameter, an import of a sandbox file.
  if (declaredAt.length > 0 && declaredAt.every((path) => insideLoose(path, SANDBOX) || insideLoose(path, DEPS))) return;

  const name = node.text;
  if (BANNED.has(name)) {
    report(node, `\`${name}\` is not allowed: it reaches code or globals outside the sandbox.`);
    return;
  }
  if (declaredAt.length === 0) return; // Unknown name: the type check reports it.
  if (declaredAt.every(isLanguageLibrary)) return; // JSON, Math, Promise, ...
  if (allowed.has(name)) return;
  report(
    node,
    name === "fetch"
      ? "`fetch` is not available. Use `deps.http.fetch` for outbound calls."
      : `\`${name}\` is not available. Only the JavaScript language and the globals listed in deps/globals.ts exist here; everything else comes from \`deps\`.`,
  );
}

/** True when the identifier only names a member or a label: it is not a reference to a variable. */
function isLabel(ast: Ast, node: Node, parent: Node): boolean {
  if (ast.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ast.isQualifiedName(parent)) return parent.right === node;
  if (ast.isBindingElement(parent)) return parent.propertyName === node;
  if (ast.isImportSpecifier(parent) || ast.isExportSpecifier(parent)) return true;
  if (ast.isLabeledStatement(parent) || ast.isBreakStatement(parent) || ast.isContinueStatement(parent)) return true;
  if (
    ast.isPropertyAssignment(parent) || ast.isPropertyDeclaration(parent) || ast.isMethodDeclaration(parent) ||
    ast.isGetAccessorDeclaration(parent) || ast.isSetAccessorDeclaration(parent) || ast.isEnumMember(parent)
  ) {
    return parent.name === node;
  }
  return false;
}

function hasDeclare(ast: Ast, node: Node): boolean {
  if (ast.isModuleDeclaration(node)) return true; // namespaces, `declare module`, `declare global`
  const modifiers = (node as { modifiers?: readonly Node[] }).modifiers;
  return modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.DeclareKeyword) ?? false;
}

function isConstructorIndex(ast: Ast, node: Node): boolean {
  if (!ast.isElementAccessExpression(node)) return false;
  const index = node.argumentExpression;
  return (ast.isStringLiteral(index) || ast.isNoSubstitutionTemplateLiteral(index)) && index.text === "constructor";
}

/** The allow-list is the `Globals` union in deps/globals.ts. */
function allowedGlobals(ast: Ast, project: Project): Set<string> {
  const names = new Set<string>();
  const source = project.program.getSourceFile(join(DEPS, "globals.ts"));
  const collect = (node: Node): void => {
    if (ast.isStringLiteral(node)) names.add(node.text);
    node.forEachChild(collect);
  };
  for (const statement of source?.statements ?? []) {
    if (ast.isTypeAliasDeclaration(statement) && statement.name.text === "Globals") collect(statement.type);
  }
  if (names.size === 0) throw new Error("deps/globals.ts must export `type Globals = \"...\" | ...`: the restrict gate reads its allow-list from there.");
  return names;
}

function isLanguageLibrary(path: string): boolean {
  const normalized = path.split("\\").join("/").toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.startsWith("lib.") && base.endsWith(".d.ts") && /\/(@typescript\/[^/]+|typescript)\/lib\//.test(normalized);
}

// ---------------------------------------------------------------------------

function listCode(directory: string): string[] {
  const found: string[] = [];
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || (directory === SANDBOX && entry === "public")) continue;
      found.push(...listCode(path));
    } else if (CODE_EXTENSIONS.has(extname(entry))) {
      found.push(path);
    }
  }
  return found;
}

function inside(path: string, directory: string): boolean {
  const full = resolve(path);
  return full === directory || full.startsWith(directory + sep);
}

/** Like `inside`, for the lower-cased paths the compiler reports on case-insensitive file systems. */
function insideLoose(path: string, directory: string): boolean {
  return inside(path, directory) || resolve(path).toLowerCase().startsWith(directory.toLowerCase() + sep);
}

function dedupe(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.file}:${problem.line}:${problem.column}:${problem.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every `*.test.ts` file under sandbox/. */
export function listTestFiles(): string[] {
  return listCode(SANDBOX).filter((file) => file.endsWith(".test.ts")).sort();
}
