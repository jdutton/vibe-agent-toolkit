#!/usr/bin/env tsx
/**
 * Derive every package's lint and typecheck configuration from what ESLint lints and what those
 * files import.
 *
 * Both tasks check ONE program per package, `tsconfig.eslint.json` (source and tests alike): the
 * typed lint reads it through typescript-eslint and `typecheck` runs `tsc --noEmit -p` on it. A
 * package's `lint` and `typecheck` are cached by turbo, so each verdict is only as fresh as its inputs. The root
 * `turbo.json` gives every package's lint the inputs every package shares (its own files, every
 * package's emitted declarations, the manifests, the rules, the installed linter). This generator
 * owns the parts that differ per package:
 *
 * - `packages/<pkg>/tsconfig.eslint.json`, the program a package's lint and typecheck check, one
 *   canonical text, for every package that holds a lintable TypeScript file;
 * - `packages/<pkg>/turbo.json` `tasks.lint.inputs` and `tasks.typecheck.inputs`: the files OUTSIDE
 *   the package that its files reach by a relative import (a shared test helper, a dev-tools
 *   generator), and what those import in turn. Such a file is part of the package's program but is
 *   not in its default inputs, so without it an edit there would replay a cached lint or typecheck
 *   the edit had changed.
 *
 * It also checks what it cannot generate: every package with a lintable file declares `lint` as
 * {@link LINT_SCRIPT} and a package without one declares none; ESLint lints no file git ignores
 * (turbo hashes only what git does not ignore); the lint tasks' installed-linter inputs name
 * exactly the packages `eslint.config.js` imports, plus `eslint` and `typescript`; and both
 * typecheck tasks (`typecheck`, `//#typecheck:root`) hash exactly what their programs and the
 * typecheck guard read. The root `turbo.json` keeps its comments, so it is checked, not written.
 * The `typecheck` and `typecheck:root` scripts are not checked here: the `typecheck-scripts` entry
 * of `vibe-agent-toolkit.config.yaml` (`vat resources check`) holds both strings and checks them,
 * keyed on a package's `tsconfig.eslint.json` existing, which {@link staleLintFiles} ties to it
 * holding a lintable TypeScript file.
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
import { pathToFileURL } from 'node:url';

import { ExitCode, type ExitCodeValue } from '@vibe-agent-toolkit/schema';
import { followedKindSync, relativeEscapesRoot, safePath, toForwardSlash, appendAll } from '@vibe-agent-toolkit/utils';
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
 * lint task, which it refuses to run unless the root `lint` script built first (`VAT_BUILT`).
 */
export const LINT_SCRIPT = 'VAT_LINT_TASK=1 eslint . --max-warnings=0';
const TSCONFIG_ESLINT = 'tsconfig.eslint.json';
/**
 * The root script every typecheck task runs through: it refuses a run the root `typecheck` script did
 * not build for (the guard a package lint passes), then runs `tsc --noEmit -p <tsconfig>`.
 */
export const TYPECHECK_TASK_FILE = 'typecheck-task.js';
/** The root's own TypeScript program, typechecked by the `//#typecheck:root` task. */
const TSCONFIG_ROOT = 'tsconfig.root.json';
const ROOT_TYPECHECK_TASK = '//#typecheck:root';
/** The code-file extensions `tsconfig.root.json` includes, as the one turbo glob of its root-level files. */
export const ROOT_TYPECHECK_GLOB = '*.{ts,cts,mts}';
/** The tasks whose per-package inputs this generator owns: both check the package's one program. */
const PROGRAM_TASKS = ['lint', 'typecheck'] as const;
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
    include: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
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

/** Parsed source files shared by every package's program, keyed by path and parse options. */
export type SourceFileCache = Map<string, ts.SourceFile | undefined>;

function configError(diagnostic: ts.Diagnostic): Error {
  return new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

/**
 * Every file the program of the tsconfig at `configRel` contains, as TypeScript itself builds it
 * from the config's root files (no type check): for a package's `tsconfig.eslint.json`, the program
 * its lint and typecheck check, ESLint-ignored fixtures included. Empty when the config does not
 * exist (a package that lints no TypeScript).
 */
function programFiles(repoRoot: string, configRel: string, cache: SourceFileCache): string[] {
  const configPath = safePath.join(repoRoot, configRel);
  if (followedKindSync(configPath, repoRoot) !== 'file') return [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw configError(diagnostic);
    },
  });
  if (parsed === undefined) throw new Error(`${configPath} could not be read`);
  const firstError = parsed.errors[0];
  if (firstError !== undefined) throw configError(firstError);
  const host = ts.createCompilerHost(parsed.options);
  const parse = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const key = `${fileName}\0${JSON.stringify(languageVersionOrOptions)}`;
    if (!cache.has(key)) cache.set(key, parse(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile));
    return cache.get(key);
  };
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host }).getSourceFiles().map((file) => file.fileName);
}

/**
 * The files outside `packages/<dir>` that the package's lint program contains, as sorted
 * repo-relative paths: what a package reaches by a relative import into another package (a shared
 * test helper, a script generator), followed however TypeScript follows it. Left out: anything in
 * `node_modules` (keyed through the lockfile), any package's `dist/` (keyed by the root task), and
 * the files `globalDependencies` hash for every task.
 */
export function foreignLintInputs(repoRoot: string, dir: string, isGlobalDependency: (rel: string) => boolean, cache: SourceFileCache): string[] {
  const packageRoot = `packages/${dir}/`;
  return keyedProgramFiles(repoRoot, `${packageRoot}${TSCONFIG_ESLINT}`, isGlobalDependency, cache).filter((rel) => !rel.startsWith(packageRoot));
}

/**
 * The program's files a task must hash itself, as sorted repo-relative paths: every file but those
 * outside the repository, in `node_modules` (keyed through the lockfile), in any package's `dist/`
 * (keyed by the task's declaration globs) or hashed for every task by `globalDependencies`.
 */
function keyedProgramFiles(repoRoot: string, configRel: string, isGlobalDependency: (rel: string) => boolean, cache: SourceFileCache): string[] {
  const realpath = ts.sys.realpath ?? ((path: string): string => path);
  const root = realpath(repoRoot);
  const keyed = programFiles(repoRoot, configRel, cache).flatMap((file) => {
    const rel = toForwardSlash(safePath.relative(root, realpath(file)));
    const excluded = relativeEscapesRoot(rel) || /(?:^|\/)node_modules\//.test(rel)
      || /^packages\/[^/]+\/dist\//.test(rel) || isGlobalDependency(rel);
    return excluded ? [] : [rel];
  });
  return [...new Set(keyed)].sort((x, y) => x.localeCompare(y));
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
  const cache: SourceFileCache = new Map();
  return Promise.all(readWorkspaceGraph(repoRoot).packages.map(async (pkg) => ({
    dir: pkg.dir,
    lintable: await lintableFiles(repoRoot, eslint, pkg.dir),
    foreign: foreignLintInputs(repoRoot, pkg.dir, isGlobalDependency, cache),
  })));
}

/**
 * The text `packages/<dir>/turbo.json` should hold, or null when it should not exist. The generator
 * owns `tasks.lint` and `tasks.typecheck`; every other task in the file is kept.
 */
export function renderPackageTurbo(currentText: string | undefined, foreign: readonly string[]): string | null {
  const { tasks: currentTasks, ...rest } = currentText === undefined ? { extends: ['//'] } : parseJsonc(TURBO_JSON, currentText);
  const tasks = { ...(currentTasks as Record<string, unknown> | undefined) };
  for (const task of PROGRAM_TASKS) {
    if (foreign.length === 0) {
      delete tasks[task];
    } else {
      tasks[task] = { inputs: [TURBO_EXTENDS, ...foreign.map((rel) => `${TURBO_ROOT}${rel}`)] };
    }
  }
  const config = Object.keys(tasks).length === 0 ? rest : { ...rest, tasks };
  const meaningful = Object.keys(config).filter((key) => key !== 'extends' && key !== '$schema');
  return meaningful.length === 0 ? null : formatTsconfig(config);
}

function readIfExists(repoRoot: string, relPath: string): string | undefined {
  const path = safePath.join(repoRoot, relPath);
  return followedKindSync(path, repoRoot) === 'file' ? readFileSync(path, 'utf8') : undefined;
}

/** Does the package hold a lintable TypeScript file, and so a `tsconfig.eslint.json` program? */
function hasProgram(plan: PackageLintPlan): boolean {
  return plan.lintable.some((rel) => /\.(?:[cm]?ts|tsx)$/.test(rel));
}

/** Every generated file not in the state the generator writes. */
export function staleLintFiles(repoRoot: string, plans: readonly PackageLintPlan[]): StaleLintFile[] {
  const tsconfigText = renderTsconfigEslint();
  return plans.flatMap((plan) => {
    const stale: StaleLintFile[] = [];
    const tsconfigRel = `packages/${plan.dir}/${TSCONFIG_ESLINT}`;
    const currentTsconfig = readIfExists(repoRoot, tsconfigRel);
    const expectedTsconfig = hasProgram(plan) ? tsconfigText : null;
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

/**
 * The listing flags for "what the repository's own ignore files leave in": tracked plus untracked,
 * minus what a `.gitignore` ignores. Not `--exclude-standard`, which also applies
 * `.git/info/exclude` and the user's global excludes: a personal ignore is not the repository's to
 * mirror, and a finding must not demand a commit for one (traps.md names the hole it leaves).
 */
const REPO_IGNORE_LISTING = ['--cached', '--others', '--exclude-per-directory=.gitignore'];

/** Rule: ESLint lints no file the repository's ignore files ignore, because turbo hashes only what git does not ignore. */
export function gitignoredLintFindings(repoRoot: string, plans: readonly PackageLintPlan[]): ValidationError[] {
  return plans.flatMap((plan) => {
    const hashed = new Set(nonDeletedGitListing(repoRoot, [`packages/${plan.dir}`], REPO_IGNORE_LISTING));
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

/** Every static import specifier of the root-level script `fileRel`. */
function staticImports(repoRoot: string, fileRel: string): string[] {
  const source = ts.createSourceFile(fileRel, readFileSync(safePath.join(repoRoot, fileRel), 'utf8'), ts.ScriptTarget.Latest);
  return source.statements.flatMap((statement) => (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : []));
}

/** Every static import specifier of `eslint.config.js`. */
function configImports(repoRoot: string): string[] {
  return staticImports(repoRoot, 'eslint.config.js');
}

/**
 * The files every typecheck task runs: {@link TYPECHECK_TASK_FILE} and each root file it imports by
 * a relative path, as root-relative paths. An edit to one changes what every typecheck does.
 */
function typecheckGuardFiles(repoRoot: string): string[] {
  const imported = staticImports(repoRoot, TYPECHECK_TASK_FILE).filter((name) => name.startsWith('./')).map((name) => name.slice(2));
  return [TYPECHECK_TASK_FILE, ...imported];
}

/** The packages a lint run loads: every bare import of `eslint.config.js`, plus {@link IMPLICIT_LINTER_PACKAGES}. */
export function linterPackages(repoRoot: string): string[] {
  const bare = configImports(repoRoot).filter((name) => !name.startsWith('.') && !name.startsWith('node:'));
  const names = bare.map(packageNameOf);
  return [...new Set([...names, ...IMPLICIT_LINTER_PACKAGES])].sort((a, b) => a.localeCompare(b));
}

/** Rule: each lint task's `node_modules/<pkg>/package.json` inputs name exactly {@link linterPackages}. */
export function linterInputFindings(repoRoot: string): ValidationError[] {
  const expected = linterPackages(repoRoot);
  return LINT_TASKS.flatMap(([task, prefix]) => {
    const declared = lintTaskInputs(repoRoot, task, prefix)
      .filter((input) => input.startsWith('node_modules/') && !input.includes('/.bun/'))
      .map((input) => input.slice('node_modules/'.length).replace(/\/package\.json$/, ''))
      .sort((a, b) => a.localeCompare(b));
    const missing = expected.filter((name) => !declared.includes(name));
    const unused = declared.filter((name) => !expected.includes(name));
    if (missing.length === 0 && unused.length === 0) return [];
    return [finding(TURBO_JSON, `The "${task}" task's installed-linter inputs must name exactly the packages eslint.config.js imports plus eslint and typescript (as ${prefix}node_modules/<pkg>/package.json). Missing: ${missing.join(', ') || 'none'}. Not imported: ${unused.join(', ') || 'none'}.`)];
  });
}

/** The two lint tasks of the root `turbo.json`, with the prefix their root-relative inputs carry. */
const LINT_TASKS: ReadonlyArray<readonly [string, string]> = [['lint', TURBO_ROOT], ['//#lint:root', '']];

function lintTaskInputs(repoRoot: string, task: string, prefix: string): string[] {
  const tasks = (rootTurbo(repoRoot)['tasks'] ?? {}) as Record<string, { inputs?: string[] }>;
  return (tasks[task]?.inputs ?? []).filter((input) => !input.startsWith('!') && input.startsWith(prefix)).map((input) => input.slice(prefix.length));
}

/**
 * Rule: every file `eslint.config.js` loads by a relative import is an input of both lint tasks.
 * The config itself is a `globalDependency`; what it imports is not, and every lint reads it.
 */
export function configImportFindings(repoRoot: string): ValidationError[] {
  const relative = configImports(repoRoot).filter((name) => name.startsWith('./')).map((name) => name.slice(2));
  return LINT_TASKS.flatMap(([task, prefix]) => {
    const matchers = lintTaskInputs(repoRoot, task, prefix).map((glob) => picomatch(glob, { dot: true }));
    return relative.filter((rel) => !matchers.some((matches) => matches(rel))).map((rel) =>
      finding(TURBO_JSON, `eslint.config.js imports ./${rel}, which no input of the "${task}" task matches, so an edit to it would replay a cached lint.`));
  });
}

/**
 * A `lint` input that describes what the package's program reads, rather than the linter: its own
 * files, any package's emitted declarations or manifest, the lockfile, the installed TypeScript.
 */
function isProgramInput(input: string): boolean {
  return input === '$TURBO_DEFAULT$' || input.startsWith(`${TURBO_ROOT}packages/*/`)
    || input === `${TURBO_ROOT}bun.lock` || input === `${TURBO_ROOT}node_modules/typescript/package.json`;
}

/** Findings for a task whose declared inputs must equal `expected`, both ways. */
function exactInputFindings(task: string, declared: readonly string[], expected: readonly string[], why: string): ValidationError[] {
  return [
    ...expected.filter((input) => !declared.includes(input)).map((input) => finding(TURBO_JSON, `The "${task}" task does not hash ${input}, ${why}.`)),
    ...declared.filter((input) => !expected.includes(input)).map((input) => finding(TURBO_JSON, `The "${task}" task hashes ${input}, which is neither a "lint" input describing the program, a file of the typecheck guard, nor a file its program reaches.`)),
  ];
}

/**
 * Rule: the root `typecheck` task hashes exactly the `lint` inputs that describe the program plus
 * the typecheck guard's files, both ways. Both tasks check the same program, so an input one lacks
 * is an edit that replays the other's cached verdict (a `schema` export change replaying `utils`'s
 * typecheck, which reaches `schema` only through `vitest.shared.ts`).
 */
export function typecheckInputFindings(repoRoot: string): ValidationError[] {
  const tasks = (rootTurbo(repoRoot)['tasks'] ?? {}) as Record<string, { inputs?: string[] }>;
  const expected = [
    ...(tasks['lint']?.inputs ?? []).filter((input) => isProgramInput(input)),
    ...typecheckGuardFiles(repoRoot).map((rel) => `${TURBO_ROOT}${rel}`),
  ];
  return exactInputFindings('typecheck', tasks['typecheck']?.inputs ?? [], expected, 'which this program or its guard reads');
}

/**
 * Rule: `//#typecheck:root` hashes exactly what the root program (`tsconfig.root.json`) reads, both
 * ways: {@link ROOT_TYPECHECK_GLOB} when the program holds a root-level file no
 * `globalDependencies` entry hashes, each deeper file it reaches that none hashes, the `typecheck`
 * task's declaration, manifest, lockfile and TypeScript inputs (root-relative), and the typecheck
 * guard's files. Not `$TURBO_DEFAULT$`, which for the root task is the whole repository.
 */
export function rootTypecheckInputFindings(repoRoot: string, cache: SourceFileCache = new Map()): ValidationError[] {
  const tasks = (rootTurbo(repoRoot)['tasks'] ?? {}) as Record<string, { inputs?: string[] }>;
  const reached = keyedProgramFiles(repoRoot, TSCONFIG_ROOT, globalDependencyMatcher(repoRoot), cache);
  const expected = [
    ...(reached.some((rel) => !rel.includes('/')) ? [ROOT_TYPECHECK_GLOB] : []),
    ...reached.filter((rel) => rel.includes('/')),
    ...(tasks['lint']?.inputs ?? []).filter((input) => isProgramInput(input) && input.startsWith(TURBO_ROOT)).map((input) => input.slice(TURBO_ROOT.length)),
    ...typecheckGuardFiles(repoRoot),
  ];
  return exactInputFindings(ROOT_TYPECHECK_TASK, tasks[ROOT_TYPECHECK_TASK]?.inputs ?? [], expected, `which the ${TSCONFIG_ROOT} program or its guard reads`);
}

/** The repository's ignore files as `eslint-config-support.js` lists them (the list `eslint.config.js` reads). */
async function declaredIgnoreFiles(repoRoot: string): Promise<readonly string[]> {
  const support = (await import(pathToFileURL(safePath.join(repoRoot, 'eslint-config-support.js')).href)) as { IGNORE_FILES: readonly string[] };
  return support.IGNORE_FILES;
}

/**
 * Rule: the ignore files `eslint.config.js` translates are exactly the tracked `.gitignore` files,
 * and both lint tasks hash every one of them (ESLint reads them for every package's lint).
 */
export function ignoreFileFindings(repoRoot: string, declared: readonly string[]): ValidationError[] {
  const tracked = nonDeletedGitListing(repoRoot, ['.gitignore', ':(glob)**/.gitignore'], ['--cached']);
  const findings = [
    ...tracked.filter((rel) => !declared.includes(rel)).map((rel) => finding(rel, 'A tracked ignore file eslint-config-support.js IGNORE_FILES does not list: ESLint would lint what it ignores, which turbo does not hash.')),
    ...declared.filter((rel) => !tracked.includes(rel)).map((rel) => finding('eslint-config-support.js', `IGNORE_FILES lists ${rel}, which is not a tracked .gitignore.`)),
  ];
  for (const [task, prefix] of LINT_TASKS) {
    const inputs = lintTaskInputs(repoRoot, task, prefix).filter((input) => input.endsWith('.gitignore'));
    appendAll(findings, [
      ...declared.filter((rel) => !inputs.includes(rel)).map((rel) => finding(TURBO_JSON, `The "${task}" task does not hash ${prefix}${rel}, which eslint.config.js reads for every lint.`)),
      ...inputs.filter((rel) => !declared.includes(rel)).map((rel) => finding(TURBO_JSON, `The "${task}" task hashes ${prefix}${rel}, which IGNORE_FILES does not list.`)),
    ]);
  }
  return findings;
}

/** The code-file extensions the root lint's inputs name, as one turbo brace group. */
export const ROOT_LINT_EXTENSIONS = '{js,cjs,mjs,jsx,ts,cts,mts,tsx}';

/**
 * Rule: `//#lint:root`'s code-file inputs are exactly one glob per place holding a file it lints:
 * `*.<ext>` for files at the root, `<dir>/**\/*.<ext>` for each top-level directory. A glob with no
 * literal prefix would make turbo walk `node_modules`, `.git` and every other session's worktree.
 */
export function rootLintInputFindings(repoRoot: string, rootLinted: readonly string[]): ValidationError[] {
  const places = new Set(rootLinted.map((rel) => (rel.includes('/') ? `${rel.slice(0, rel.indexOf('/'))}/**/*.${ROOT_LINT_EXTENSIONS}` : `*.${ROOT_LINT_EXTENSIONS}`)));
  const declared = lintTaskInputs(repoRoot, '//#lint:root', '').filter((input) => input.endsWith(`*.${ROOT_LINT_EXTENSIONS}`));
  return [
    ...[...places].filter((glob) => !declared.includes(glob)).map((glob) => finding(TURBO_JSON, `The "//#lint:root" task lints files that "${glob}" would hash; add it to its inputs.`)),
    ...declared.filter((glob) => !places.has(glob)).map((glob) => finding(TURBO_JSON, `The "//#lint:root" task input "${glob}" matches no file it lints; remove it.`)),
  ];
}

/** The files `//#lint:root` lints (`eslint . --ignore-pattern 'packages/**'`), from the repository's listing. */
async function rootLintedFiles(repoRoot: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot, ignorePatterns: ['packages/**'] });
  const files = nonDeletedGitListing(repoRoot, ['.'], REPO_IGNORE_LISTING).filter((rel) => !rel.startsWith('packages/'));
  const linted = await Promise.all(files.map(async (rel) => {
    const file = safePath.join(repoRoot, rel);
    return !(await eslint.isPathIgnored(file)) && (await eslint.calculateConfigForFile(file)) !== undefined;
  }));
  return files.filter((_, index) => linted[index]);
}

/** Every lint-config finding, for `validate-structure`: generated files, lint and typecheck scripts, git agreement and linter inputs. */
export async function collectLintConfigFindings(repoRoot: string): Promise<ValidationError[]> {
  const plans = await planLintConfig(repoRoot);
  const stale = staleLintFiles(repoRoot, plans).map((file) =>
    ({ type: ERROR_TYPES.DERIVED_ARTIFACT_STALE, path: file.relPath, message: 'Generated from what ESLint lints and what those files import, never hand-edited: run `bun run generate:lint-config`.', severity: 'error' as const }));
  return [
    ...stale,
    ...lintScriptFindings(repoRoot, plans),
    ...gitignoredLintFindings(repoRoot, plans),
    ...linterInputFindings(repoRoot),
    ...configImportFindings(repoRoot),
    ...typecheckInputFindings(repoRoot),
    ...rootTypecheckInputFindings(repoRoot),
    ...ignoreFileFindings(repoRoot, await declaredIgnoreFiles(repoRoot)),
    ...rootLintInputFindings(repoRoot, await rootLintedFiles(repoRoot)),
  ];
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
