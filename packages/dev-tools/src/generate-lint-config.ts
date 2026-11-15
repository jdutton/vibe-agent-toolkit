#!/usr/bin/env tsx
/**
 * Derive every package's lint configuration from what ESLint lints and what those files import.
 *
 * A package's `lint` is cached by turbo, so its verdict is only as fresh as its inputs. The root
 * `turbo.json` gives every package's lint the inputs every package shares (its own files, every
 * package's emitted declarations, the manifests, the rules, the installed linter). This generator
 * owns the parts that differ per package:
 *
 * - `packages/<pkg>/tsconfig.eslint.json`, the program a package's lint type-checks, one canonical
 *   text, for every package that holds a lintable TypeScript file;
 * - `packages/<pkg>/turbo.json` `tasks.lint.inputs`: the files OUTSIDE the package that its files
 *   reach by a relative import (a shared test helper, a dev-tools generator), and what those import
 *   in turn. Such a file is part of the package's program but is not in its default inputs, so
 *   without it an edit there would replay a cached lint the edit had changed.
 *
 * It also checks what it cannot generate: every package with a lintable file declares `lint` as
 * {@link LINT_SCRIPT} and a package without one declares none; ESLint lints no file git ignores
 * (turbo hashes only what git does not ignore); and the lint tasks' installed-linter inputs name
 * exactly the packages `eslint.config.js` imports, plus `eslint` and `typescript`.
 *
 * "Lintable" is asked of ESLint itself (`isPathIgnored`, `calculateConfigForFile`), never of a
 * hand-kept list of extensions or directories.
 *
 * Usage:
 *   bun run --cwd packages/dev-tools generate:lint-config           # rewrite every generated file
 *   bun run --cwd packages/dev-tools generate:lint-config --check   # exit 1 if anything is stale or wrong
 *
 * `validate-structure` runs the check.
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ExitCode, type ExitCodeValue } from '@vibe-agent-toolkit/schema';
import { followedKindSync, relativeEscapesRoot, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { ESLint } from 'eslint';
import picomatch from 'picomatch';
import ts from 'typescript';

import { nonDeletedGitListing } from './comment-density.js';
import { isEntrypoint, log, PROJECT_ROOT } from './common.js';
import { formatTsconfig } from './generate-tsconfig-refs.js';
import { ERROR_TYPES, type ValidationError } from './structure-finding.js';
import { readWorkspaceGraph } from './workspace-graph.js';

/**
 * The one per-package lint invocation. `VAT_LINT_TASK=1` tells `eslint.config.js` this is a cached
 * lint task, which it refuses to run unless the root `lint` script built first (`VAT_LINT_BUILT`).
 */
export const LINT_SCRIPT = 'VAT_LINT_TASK=1 eslint . --max-warnings=0';
const TSCONFIG_ESLINT = 'tsconfig.eslint.json';
const TURBO_JSON = 'turbo.json';
/** The marker turbo expands to the root's inputs for the same task. */
const TURBO_EXTENDS = '$TURBO_EXTENDS$';
const TURBO_ROOT = '$TURBO_ROOT$/';
/** Packages the lint tasks read besides what `eslint.config.js` imports. */
const IMPLICIT_LINTER_PACKAGES = ['eslint', 'typescript'];

/** A generated file whose committed state differs from what the generator writes; `expected: null` means it should not exist. */
export interface StaleLintFile {
  readonly relPath: string;
  readonly expected: string | null;
}

/** One package's lint facts: what ESLint lints in it, and what outside it those files reach. */
export interface PackageLintPlan {
  readonly dir: string;
  /** Repo-relative paths ESLint lints in the package. */
  readonly lintable: readonly string[];
  /** Repo-relative paths outside the package that its files reach by relative imports, sorted. */
  readonly foreign: readonly string[];
}

/** The fixed text of every `tsconfig.eslint.json`. */
export function renderTsconfigEslint(): string {
  return formatTsconfig({
    $schema: 'https://json.schemastore.org/tsconfig',
    extends: '../../tsconfig.base.json',
    compilerOptions: { noEmit: true, composite: false },
    include: ['**/*.ts', '**/*.tsx', '**/*.cts'],
    exclude: ['**/dist', '**/node_modules', '**/coverage', '**/generated', '**/.tsc-staging'],
  });
}

/** Every file on disk under `dir` except inside `node_modules`, without following links. */
function filesOnDisk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const path = safePath.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesOnDisk(path);
    return entry.isFile() ? [path] : [];
  });
}

/** The files ESLint lints under `packages/<dir>`, as repo-relative paths, by asking ESLint. */
export async function lintableFiles(repoRoot: string, eslint: ESLint, dir: string): Promise<string[]> {
  const files = filesOnDisk(safePath.join(repoRoot, 'packages', dir));
  const linted = await Promise.all(files.map(async (file) =>
    !(await eslint.isPathIgnored(file)) && (await eslint.calculateConfigForFile(file)) !== undefined));
  return files.filter((_, index) => linted[index]).map((file) => toForwardSlash(safePath.relative(repoRoot, file))).sort((a, b) => a.localeCompare(b));
}

/** How TypeScript maps an emitted extension in a specifier back to the sources it may name. */
const SOURCE_EXTENSIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['.js', ['.ts', '.tsx', '.js']],
  ['.jsx', ['.tsx', '.jsx']],
  ['.cjs', ['.cts', '.cjs']],
  ['.mjs', ['.mts', '.mjs']],
];

/**
 * The file a relative specifier names, resolved the way TypeScript resolves it, or undefined. A
 * candidate outside `within` (the repository) is never probed.
 */
export function resolveRelativeSpecifier(fromFile: string, specifier: string, within: string): string | undefined {
  const base = safePath.resolve(dirname(fromFile), specifier);
  const mapped = SOURCE_EXTENSIONS.flatMap(([ext, sources]) =>
    base.endsWith(ext) ? sources.map((source) => base.slice(0, -ext.length) + source) : []);
  const candidates = [...mapped, base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, safePath.join(base, 'index.ts'), safePath.join(base, 'index.js')];
  return candidates.find((candidate) =>
    !relativeEscapesRoot(toForwardSlash(safePath.relative(within, candidate))) && followedKindSync(candidate, within) === 'file');
}

/** The module specifier a node names, if it is an import, export-from, import-equals, `import()` or `require()` of a string. */
function specifierOf(node: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
    return node.moduleReference.expression.text;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0] as ts.Expression)) {
    const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    if (isImport || isRequire) return (node.arguments[0] as ts.StringLiteral).text;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
    return node.argument.literal.text;
  }
  return undefined;
}

/**
 * The relative specifiers a file imports, re-exports, requires or references, from its syntax tree:
 * real statements and expressions only, never text in a comment or a string.
 */
export function relativeSpecifiers(text: string, fileName = 'file.ts'): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const found = source.referencedFiles.map((ref) => ref.fileName);
  const visit = (node: ts.Node): void => {
    const specifier = specifierOf(node);
    if (specifier !== undefined) found.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.filter((name) => /^\.{1,2}\//.test(name));
}

/**
 * Every file outside `packages/<dir>` that the package's files reach through relative imports,
 * followed transitively through whatever they import, as sorted repo-relative paths. A file the
 * root's `globalDependencies` already hash for every task, and anything under `node_modules`, is
 * left out.
 */
export function foreignLintInputs(repoRoot: string, dir: string, startFiles: readonly string[], isGlobalDependency: (rel: string) => boolean): string[] {
  const packageRoot = `packages/${dir}/`;
  const seen = new Set<string>();
  const foreign = new Set<string>();
  const queue = startFiles.map((rel) => safePath.join(repoRoot, rel));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const rel = toForwardSlash(safePath.relative(repoRoot, file));
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.startsWith(packageRoot)) foreign.add(rel);
    if (!/\.[cm]?[jt]sx?$/.test(rel) || rel.endsWith('.d.ts')) continue;
    for (const specifier of relativeSpecifiers(readFileSync(file, 'utf8'), file)) {
      const target = resolveRelativeSpecifier(file, specifier, repoRoot);
      if (target === undefined) continue;
      const targetRel = toForwardSlash(safePath.relative(repoRoot, target));
      if (/(?:^|\/)node_modules\//.test(targetRel) || isGlobalDependency(targetRel)) continue;
      queue.push(target);
    }
  }
  return [...foreign].sort((a, b) => a.localeCompare(b));
}

/** Parse a JSON-with-comments config the way turbo reads it. */
function parseJsonc(relPath: string, text: string): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(relPath, text);
  if (parsed.error !== undefined || typeof parsed.config !== 'object' || parsed.config === null) {
    throw new Error(`${relPath} is not valid JSON with comments`);
  }
  return parsed.config as Record<string, unknown>;
}

function rootTurbo(repoRoot: string): Record<string, unknown> {
  return parseJsonc(TURBO_JSON, readFileSync(safePath.join(repoRoot, TURBO_JSON), 'utf8'));
}

/** A predicate for the root files `globalDependencies` hash into every task. */
function globalDependencyMatcher(repoRoot: string): (rel: string) => boolean {
  const globs = (rootTurbo(repoRoot)['globalDependencies'] ?? []) as string[];
  const matchers = globs.map((glob) => picomatch(glob, { dot: true }));
  return (rel) => matchers.some((matches) => matches(rel));
}

/** The lint facts of every workspace package, by directory. */
export function planLintConfig(repoRoot: string): Promise<PackageLintPlan[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const isGlobalDependency = globalDependencyMatcher(repoRoot);
  return Promise.all(readWorkspaceGraph(repoRoot).packages.map(async (pkg) => {
    const lintable = await lintableFiles(repoRoot, eslint, pkg.dir);
    return { dir: pkg.dir, lintable, foreign: foreignLintInputs(repoRoot, pkg.dir, lintable, isGlobalDependency) };
  }));
}

/**
 * The text `packages/<dir>/turbo.json` should hold, or null when it should not exist. The generator
 * owns ONE key, `tasks.lint`; every other task in the file is kept.
 */
export function renderPackageTurbo(currentText: string | undefined, foreign: readonly string[]): string | null {
  const config: Record<string, unknown> = currentText === undefined ? { extends: ['//'], tasks: {} } : (JSON.parse(currentText) as Record<string, unknown>);
  const tasks = { ...(config['tasks'] as Record<string, unknown> | undefined) };
  if (foreign.length === 0) {
    delete tasks['lint'];
  } else {
    tasks['lint'] = { inputs: [TURBO_EXTENDS, ...foreign.map((rel) => `${TURBO_ROOT}${rel}`)] };
  }
  if (Object.keys(tasks).length === 0) return null;
  return formatTsconfig({ ...config, tasks });
}

function readIfExists(repoRoot: string, relPath: string): string | undefined {
  const path = safePath.join(repoRoot, relPath);
  return followedKindSync(path, repoRoot) === 'file' ? readFileSync(path, 'utf8') : undefined;
}

/** Every generated file not in the state the generator writes. */
export function staleLintFiles(repoRoot: string, plans: readonly PackageLintPlan[]): StaleLintFile[] {
  const tsconfigText = renderTsconfigEslint();
  return plans.flatMap((plan) => {
    const stale: StaleLintFile[] = [];
    const tsconfigRel = `packages/${plan.dir}/${TSCONFIG_ESLINT}`;
    const currentTsconfig = readIfExists(repoRoot, tsconfigRel);
    const expectedTsconfig = plan.lintable.some((rel) => /\.(?:[cm]?ts|tsx)$/.test(rel)) ? tsconfigText : null;
    if ((currentTsconfig ?? null) !== expectedTsconfig) stale.push({ relPath: tsconfigRel, expected: expectedTsconfig });
    const turboRel = `packages/${plan.dir}/${TURBO_JSON}`;
    const currentTurbo = readIfExists(repoRoot, turboRel);
    const expectedTurbo = renderPackageTurbo(currentTurbo, plan.foreign);
    if ((currentTurbo ?? null) !== expectedTurbo) stale.push({ relPath: turboRel, expected: expectedTurbo });
    return stale;
  });
}

const finding = (path: string, message: string): ValidationError => ({ type: ERROR_TYPES.STRUCTURAL_VIOLATION, path, message, severity: 'error' });

/** Rule: a package with a lintable file declares `lint` exactly as {@link LINT_SCRIPT}; one without declares none. */
export function lintScriptFindings(repoRoot: string, plans: readonly PackageLintPlan[]): ValidationError[] {
  const manifests = new Map(readWorkspaceGraph(repoRoot).packages.map((pkg) => [pkg.dir, pkg.manifest]));
  return plans.flatMap((plan) => {
    const lint = ((manifests.get(plan.dir)?.['scripts'] ?? {}) as Record<string, string>)['lint'];
    const path = `packages/${plan.dir}/package.json`;
    if (plan.lintable.length > 0 && lint !== LINT_SCRIPT) {
      return [finding(path, `\`lint\` must be exactly ${JSON.stringify(LINT_SCRIPT)}; found ${JSON.stringify(lint)}. Without it the root \`lint\` (turbo) skips this package.`)];
    }
    if (plan.lintable.length === 0 && lint !== undefined) {
      return [finding(path, '`lint` is declared but ESLint lints no file in this package; ESLint refuses a run where every file is ignored.')];
    }
    return [];
  });
}

/** Rule: ESLint lints no file git ignores, because turbo hashes only the files git does not ignore. */
export function gitignoredLintFindings(repoRoot: string, plans: readonly PackageLintPlan[]): ValidationError[] {
  return plans.flatMap((plan) => {
    const hashed = new Set(nonDeletedGitListing(repoRoot, [`packages/${plan.dir}`], ['--cached', '--others', '--exclude-standard']));
    return plan.lintable.filter((rel) => !hashed.has(rel)).map((rel) =>
      finding(rel, 'ESLint lints this file but git ignores it, so turbo does not hash it and a cached lint replays over an edit to it. Make eslint.config.js ignore what git ignores (`gitignoredPatterns()`).'));
  });
}

/** The package a bare specifier names: `@scope/name` or `name`, without any subpath. */
function packageNameOf(specifier: string): string {
  const first = specifier.indexOf('/');
  const end = specifier.startsWith('@') && first !== -1 ? specifier.indexOf('/', first + 1) : first;
  return end === -1 ? specifier : specifier.slice(0, end);
}

/** The packages a lint run loads: every bare import of `eslint.config.js`, plus {@link IMPLICIT_LINTER_PACKAGES}. */
export function linterPackages(repoRoot: string): string[] {
  const source = ts.createSourceFile('eslint.config.js', readFileSync(safePath.join(repoRoot, 'eslint.config.js'), 'utf8'), ts.ScriptTarget.Latest);
  const bare = source.statements
    .flatMap((statement) => (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : []))
    .filter((name) => !name.startsWith('.') && !name.startsWith('node:'));
  const names = bare.map(packageNameOf);
  return [...new Set([...names, ...IMPLICIT_LINTER_PACKAGES])].sort((a, b) => a.localeCompare(b));
}

/** Rule: each lint task's `node_modules/<pkg>/package.json` inputs name exactly {@link linterPackages}. */
export function linterInputFindings(repoRoot: string): ValidationError[] {
  const expected = linterPackages(repoRoot);
  const tasks = (rootTurbo(repoRoot)['tasks'] ?? {}) as Record<string, { inputs?: string[] }>;
  const sites: Array<readonly [string, string]> = [['lint', TURBO_ROOT], ['//#lint:root', '']];
  return sites.flatMap(([task, prefix]) => {
    const declared = (tasks[task]?.inputs ?? [])
      .filter((input) => input.startsWith(`${prefix}node_modules/`) && !input.includes('/.bun/'))
      .map((input) => input.slice(`${prefix}node_modules/`.length).replace(/\/package\.json$/, ''))
      .sort((a, b) => a.localeCompare(b));
    const missing = expected.filter((name) => !declared.includes(name));
    const unused = declared.filter((name) => !expected.includes(name));
    if (missing.length === 0 && unused.length === 0) return [];
    return [finding(TURBO_JSON, `The "${task}" task's installed-linter inputs must name exactly the packages eslint.config.js imports plus eslint and typescript (as ${prefix}node_modules/<pkg>/package.json). Missing: ${missing.join(', ') || 'none'}. Not imported: ${unused.join(', ') || 'none'}.`)];
  });
}

/** Every lint-config finding, for `validate-structure`: generated files, scripts, git agreement and linter inputs. */
export async function collectLintConfigFindings(repoRoot: string): Promise<ValidationError[]> {
  const plans = await planLintConfig(repoRoot);
  const stale = staleLintFiles(repoRoot, plans).map((file) =>
    ({ type: ERROR_TYPES.DERIVED_ARTIFACT_STALE, path: file.relPath, message: 'Generated from what ESLint lints and what those files import, never hand-edited: run `bun run generate:lint-config`.', severity: 'error' as const }));
  return [...stale, ...lintScriptFindings(repoRoot, plans), ...gitignoredLintFindings(repoRoot, plans), ...linterInputFindings(repoRoot)];
}

async function main(argv: readonly string[]): Promise<ExitCodeValue> {
  if (argv.includes('--check')) {
    const findings = await collectLintConfigFindings(PROJECT_ROOT);
    for (const item of findings) log(`✗ ${item.path}: ${item.message}`, 'red');
    if (findings.length === 0) log('✓ Lint configuration matches what ESLint lints', 'green');
    return findings.length === 0 ? ExitCode.OK : ExitCode.FINDINGS;
  }
  const stale = staleLintFiles(PROJECT_ROOT, await planLintConfig(PROJECT_ROOT));
  for (const file of stale) {
    const path = safePath.join(PROJECT_ROOT, file.relPath);
    if (file.expected === null) rmSync(path, { force: true });
    else writeFileSync(path, file.expected, 'utf8');
    log(`  ✓ ${file.relPath}`, 'green');
  }
  log(`✓ ${stale.length.toString()} generated lint file(s) rewritten`, 'green');
  return ExitCode.OK;
}

if (isEntrypoint(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
