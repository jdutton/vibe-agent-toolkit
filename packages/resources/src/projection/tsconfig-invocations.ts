/**
 * `tsconfig_invocations`: the TypeScript projects a repository's `package.json` scripts compile.
 * Pure: it reads one `package.json`'s `data__nodes` rows and a git-content membership predicate,
 * never the disk.
 *
 * ## Tokenisation (the guard's), then tsc's command line
 *
 * Each script value is split on `&&`, `||` and `;`, then on whitespace. A segment compiles when one
 * of its tokens has a basename (the text after the last `/`) in the compiler set
 * (`resources.typescript.compilers`, default {@link DEFAULT_TSCONFIG_COMPILERS}), so
 * `node_modules/.bin/tsc` and `npx tsc` both compile. The arguments after that token, up to a pipe,
 * redirection or `&`, are read as tsc reads its command line (`executeCommandLine`):
 *
 * - Option names are case-insensitive (`-P`, `--Project`), with one or two dashes, and no option
 *   takes `=value`: `--project=x` is TS5023, so the segment compiles nothing and has no row.
 * - `-b` or `--build` counts only as the FIRST argument (build mode). Its positionals are projects,
 *   a `.json` one a file and any other a directory; none means `.`. `-b --clean` and `-b -p` produce no row.
 * - Outside build mode `-p`/`--project` (the last wins) names a file or a directory as tsc decides,
 *   by what exists: a path that is git content, or ends in `.json`, is a file, anything else a
 *   directory holding `tsconfig.json`. With source files beside it tsc refuses (TS5042): no row.
 * - Outside build mode, with no `-p`, source files on the command line mean no config is read
 *   (TS5112 if one exists): no row. With none, a bare `tsc` walks UP from the package directory to
 *   the nearest `tsconfig.json` (`findConfigFile`); the row names that file, and when none exists
 *   inside the analysis root the walk may continue above it, which the reader cannot see.
 * - `--version`, `-v`, `--init`, `--help`, `-h`, `-?`, `--all`, `--showConfig` and `--ignoreConfig`
 *   compile no config: no row.
 *
 * ## What the reader cannot know, and says so
 *
 * A segment whose project depends on something the script text does not settle is a
 * `TSCONFIG_INVOKED_UNKNOWN` condition at the `package.json`, with no invocation row and no
 * `TSCONFIG_INVOKED_MISSING`: a `cd`, `pushd` or `popd` earlier in the script; a launcher option
 * that changes the working directory (`-C`, `--dir`, `--cwd`, `--prefix`, `-w`, `--workspace`,
 * `--filter`, `-F`); an argument the shell expands (`*`, `?`, `[`, `{`, `$`, a backtick) or a
 * response file (`@args`); a bare `tsc` whose walk finds no `tsconfig.json` inside the root.
 * Known limits: whether a bare positional is a source file is read from its extension
 * (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`), after skipping the value
 * of the common value-taking options; an uncommon option's value that has such an extension is read
 * as a source file. Build-mode option values are read as projects.
 *
 * ## The columns this module defines
 *
 * - `script`: the script's name; a repeated name contributes its last occurrence only (the
 *   unshadowed node, `shadowed = 0`).
 * - `segment`: the 0-based position of the compiling segment among the script's segments, counting
 *   segments that run no compiler.
 * - `ordinal`: the 0-based position among the projects that segment names (always 0 outside build mode).
 * - `project`: the project as named, normalised and relative to the root; a `..` first segment
 *   leaves the root.
 * - `config`: the tsconfig file, or null when it is not git content or the project leaves the root.
 * - `line`: the line of the script's value in the `package.json`, from its `data__nodes` row.
 *
 * ## Conditions and marks
 *
 * A named file that is not git content is a `TSCONFIG_INVOKED_MISSING` condition and a null `config`
 * (never a refusal); a project the reader cannot determine is a `TSCONFIG_INVOKED_UNKNOWN` condition. A project leaving the root is returned in `outsideRoot`, which the resolve step
 * refuses on (`TSCONFIG_INVOKED_OUTSIDE_ROOT`); it has a null `config` and no missing condition.
 *
 * ## Where the compiler set comes from
 *
 * `resources.typescript.compilers` in the project config; callers pass
 * {@link compilersFromConfig}`(config)`, which falls back to the default.
 */

import { toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';

import type { ProjectConfig } from '../schemas/project-config.js';
import type { DataNodeRow } from '../schemas/projection-data.js';
import {
  DEFAULT_TSCONFIG_COMPILERS,
  type TsconfigConditionRow,
  type TsconfigInvocationRow,
} from '../schemas/projection-tsconfig.js';

const TSCONFIG = 'tsconfig.json';
const SEGMENT_SPLIT = /&&|\|\||;/;
const WHITESPACE = /\s+/;

/** What the invocation tokeniser reads for one `package.json`. */
export interface InvocationInput {
  /** The id of the root the file is under */
  readonly root: string;
  /** The `package.json`, relative to the root */
  readonly path: string;
  /** The file's `data__nodes` rows; shadowed nodes and documents after the first are ignored */
  readonly nodes: readonly DataNodeRow[];
  /** The command basenames read as the compiler */
  readonly compilers: readonly string[];
  /** Whether a root-relative path is git content */
  readonly isGitContent: (path: string) => boolean;
}

/** What one `package.json` contributes. */
interface InvocationResult {
  readonly invocations: readonly TsconfigInvocationRow[];
  readonly conditions: readonly TsconfigConditionRow[];
  /** The invocations whose project leaves the root: the step refuses on them */
  readonly outsideRoot: readonly TsconfigInvocationRow[];
}

/** @returns The configured compiler set, or the default when the config names none */
export function compilersFromConfig(config: ProjectConfig | undefined): readonly string[] {
  return config?.resources?.typescript?.compilers ?? DEFAULT_TSCONFIG_COMPILERS;
}

/** @returns `segments` joined and normalised (`.` and `..` resolved), `..` kept when it climbs above the start */
function normalise(parts: readonly string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length > 0 && out.at(-1) !== '..') out.pop();
    else out.push(part);
  }
  return out.length === 0 ? '.' : out.join('/');
}

/** @returns The token without one pair of surrounding quotes */
function unquote(token: string): string {
  const first = token.at(0);
  return token.length >= 2 && (first === '"' || first === '\'') && token.at(-1) === first ? token.slice(1, -1) : token;
}

/** What a compiling segment's arguments come to. */
type Reading =
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly why: string }
  | { readonly kind: 'build'; readonly projects: readonly string[] }
  | { readonly kind: 'project'; readonly written: string }
  | { readonly kind: 'walk' };

const NONE: Reading = { kind: 'none' };
/** Options after which tsc compiles no config. */
const NO_COMPILE_OPTIONS = new Set(['version', 'init', 'help', 'h', '?', 'all', 'showconfig', 'ignoreconfig']);
/** The common options that take a value, whose value is not a source file whatever its extension. */
const VALUE_OPTIONS = new Set([
  'outfile', 'outdir', 'rootdir', 'rootdirs', 'declarationdir', 'tsbuildinfofile', 'baseurl', 'target', 't', 'module', 'm', 'lib',
  'types', 'typeroots', 'jsx', 'moduleresolution', 'moduledetection', 'jsxfactory', 'jsxfragmentfactory', 'jsximportsource',
  'newline', 'locale', 'maproot', 'sourceroot', 'watchfile', 'watchdirectory', 'fallbackpolling', 'generatecpuprofile', 'maxnodemodulejsdepth',
]);
/** A source file's extension: what makes a bare argument a file rather than an option's value. */
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx|json)$/iu;
/** A token that ends a command's own arguments: a pipe, a redirection, a background `&`. */
const SHELL_OPERATOR = /^(?:[|&]|\d?[<>])/u;
/** A token the shell expands, or a response file. */
const SHELL_EXPANDED = /[*?[{$`]|^@/u;
/** A launcher option that changes the working directory the compiler runs in. */
const CHANGES_DIRECTORY = new Set(['-C', '--dir', '--cwd', '--prefix', '-w', '--workspace', '-F', '--filter']);
const DIRECTORY_COMMANDS = new Set(['cd', 'pushd', 'popd']);

/** @returns The option's lower-cased name without its dashes, or undefined for a positional */
function optionName(token: string): string | undefined {
  if (!token.startsWith('-') || token === '-') return undefined;
  return token.slice(token.startsWith('--') ? 2 : 1).toLowerCase();
}

/** What one option does to the reading of a command line. */
type OptionEffect = 'none' | 'project' | 'value' | 'plain' | 'build-position';

/** @returns What `name` does outside or inside build mode */
function optionEffect(name: string, build: boolean): OptionEffect {
  if (name.includes('=') || NO_COMPILE_OPTIONS.has(name)) return 'none';
  if ((name === 'v' && !build) || (name === 'clean' && build)) return 'none';
  if (name === 'b' || name === 'build') return 'build-position';
  if (name === 'p' || name === 'project') return build ? 'none' : 'project';
  return VALUE_OPTIONS.has(name) ? 'value' : 'plain';
}

/** The options and positionals of a command line, or undefined when tsc compiles no config for it. */
function scanArguments(args: readonly string[], build: boolean): { readonly project: string | undefined; readonly positionals: readonly string[] } | undefined {
  let project: string | undefined;
  const positionals: string[] = [];
  for (let index = build ? 1 : 0; index < args.length; index++) {
    const token = args[index] ?? '';
    const name = optionName(token);
    if (name === undefined) {
      positionals.push(token);
      continue;
    }
    const effect = optionEffect(name, build);
    if (effect === 'none' || effect === 'build-position') return undefined;
    if (effect === 'project') {
      if (args[index + 1] === undefined) return undefined;
      project = args[++index];
    } else if (effect === 'value') {
      index++;
    }
  }
  return { project, positionals };
}

/** @returns What tsc does with `tokens` (the tokens after the compiler), as `executeCommandLine` reads them */
function readArguments(tokens: readonly string[]): Reading {
  const cut = tokens.findIndex((token) => SHELL_OPERATOR.test(token));
  const args = cut < 0 ? tokens : tokens.slice(0, cut);
  if (args.some((token) => SHELL_EXPANDED.test(token))) return { kind: 'unknown', why: 'an argument is expanded by the shell or is a response file' };
  const build = ['b', 'build'].includes(optionName(args[0] ?? '') ?? '');
  const scanned = scanArguments(args, build);
  if (scanned === undefined) return NONE;
  const { project, positionals } = scanned;
  if (build) return { kind: 'build', projects: positionals.length > 0 ? positionals : [''] };
  if (positionals.some((token) => SOURCE_FILE.test(token))) return NONE;
  return project === undefined ? { kind: 'walk' } : { kind: 'project', written: project };
}

/** One script: its name, command text and the line of its value. */
interface Script {
  readonly name: string;
  readonly command: string;
  readonly line: number;
}

/** @returns The package's name and the unshadowed string scripts of its first document, in file order */
function readPackage(nodes: readonly DataNodeRow[]): { readonly name: string | null; readonly scripts: readonly Script[] } {
  const live = nodes.filter((node) => node.doc === 0 && !node.shadowed);
  const rootNode = live.find((node) => node.pointer === '');
  const member = (parent: number | null, key: string): DataNodeRow | undefined =>
    live.find((node) => node.parent === parent && node.key === key);
  const nameNode = rootNode === undefined ? undefined : member(rootNode.ordinal, 'name');
  const scriptsNode = rootNode === undefined ? undefined : member(rootNode.ordinal, 'scripts');
  const scripts = scriptsNode?.type === 'object'
    ? live
      .filter((node) => node.parent === scriptsNode.ordinal && node.type === 'string' && typeof node.value === 'string' && node.key !== null)
      .map((node) => ({ name: node.key ?? '', command: String(node.value), line: node.line }))
    : [];
  return { name: nameNode?.type === 'string' && typeof nameNode.value === 'string' ? nameNode.value : null, scripts };
}

/** @returns The slash-separated parts of a root-relative or authored path */
function partsOf(text: string): string[] {
  return toForwardSlashAnyPlatform(text).split('/');
}

/** One project a segment names, resolved against the package directory. */
interface Resolved {
  readonly project: string;
  readonly named: string;
  readonly leaves: boolean;
}

/** @returns The normalised project, the file it names, and whether it leaves the root */
function resolveProject(written: string, packageDir: string, isFile: (project: string) => boolean): Resolved {
  const absolute = written.startsWith('/');
  const base = packageDir === '.' ? [] : partsOf(packageDir);
  if (written === '') return { project: normalise([...base, TSCONFIG]), named: normalise([...base, TSCONFIG]), leaves: false };
  const project = normalise(absolute ? ['..'] : [...base, ...partsOf(written)]);
  const named = isFile(project) ? project : normalise([project, TSCONFIG]);
  return { project, named, leaves: absolute || project === '..' || project.startsWith('../') };
}

/** @returns The nearest `tsconfig.json` at or above `packageDir` that is git content, as tsc's `findConfigFile` walks */
function nearestConfig(packageDir: string, isGitContent: (path: string) => boolean): string | undefined {
  const parts = packageDir === '.' ? [] : partsOf(packageDir);
  for (let depth = parts.length; depth >= 0; depth--) {
    const candidate = normalise([...parts.slice(0, depth), TSCONFIG]);
    if (isGitContent(candidate)) return candidate;
  }
  return undefined;
}

/** @returns The compiler token of a segment's tokens, the tokens before it (its launcher) and after it, or undefined when it runs none */
function compilerIn(tokens: readonly string[], compilers: readonly string[]): { readonly compiler: string; readonly launcher: readonly string[]; readonly args: readonly string[] } | undefined {
  const at = tokens.findIndex((token) => compilers.includes(basenameOf(token)));
  return at < 0 ? undefined : { compiler: basenameOf(tokens[at] ?? ''), launcher: tokens.slice(0, at), args: tokens.slice(at + 1) };
}

/** @returns The text after the last `/` */
function basenameOf(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

/** What a package.json's invocations accumulate into. */
interface Sink {
  readonly invocations: TsconfigInvocationRow[];
  readonly conditions: TsconfigConditionRow[];
  readonly outsideRoot: TsconfigInvocationRow[];
}

/** One package.json's fixed context while its scripts are read. */
interface Context extends InvocationInput {
  readonly packageDir: string;
  readonly name: string | null;
}

/** @returns The token without the parentheses of a subshell at either edge */
function stripParentheses(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && token[start] === '(') start++;
  while (end > start && token[end - 1] === ')') end--;
  return token.slice(start, end);
}

/** @returns The tokens of a segment, quotes and the edge parentheses of a subshell removed */
function tokensOf(text: string): string[] {
  return text.split(WHITESPACE).map((token) => stripParentheses(unquote(token))).filter((token) => token !== '');
}

/** Add a condition, its `seq` the position among this package.json's conditions of its code. */
function addCondition(context: Context, sink: Sink, code: TsconfigConditionRow['code'], message: string): void {
  const seq = sink.conditions.filter((condition) => condition.code === code).length;
  sink.conditions.push({ root: context.root, path: context.path, code, seq, message, kind: null, reached: null });
}

/** The projects a reading names, as `[written, how to tell a file from a directory]`; undefined when it names none. */
function projectsOfReading(reading: Reading, context: Context): Resolved[] | undefined {
  const { packageDir, isGitContent } = context;
  if (reading.kind === 'build') return reading.projects.map((written) => resolveProject(written, packageDir, (project) => project.endsWith('.json')));
  if (reading.kind === 'project') return [resolveProject(reading.written, packageDir, (project) => project.endsWith('.json') || isGitContent(project))];
  if (reading.kind === 'walk') {
    const found = nearestConfig(packageDir, isGitContent);
    return found === undefined ? undefined : [{ project: found, named: found, leaves: false }];
  }
  return undefined;
}

/** @returns Why the working directory is not the package's, or undefined when it is */
function directoryChanged(launcher: readonly string[], directoryKnown: boolean): string | undefined {
  if (directoryKnown && !launcher.some((token) => CHANGES_DIRECTORY.has(token.split('=')[0] ?? ''))) return undefined;
  return 'the working directory it runs in is changed by the script (`cd`) or its launcher, so a relative project cannot be resolved';
}

/** Read one compiling segment's projects into the sink; `directoryKnown` is false after a `cd`. */
function readSegment(context: Context, script: Script, segment: number, tokens: readonly string[], directoryKnown: boolean, sink: Sink): void {
  const found = compilerIn(tokens, context.compilers);
  if (found === undefined) return;
  const reading = readArguments(found.args);
  if (reading.kind === 'none') return;
  const unknown = reading.kind === 'unknown' ? reading.why : directoryChanged(found.launcher, directoryKnown);
  const resolved = unknown === undefined ? projectsOfReading(reading, context) : undefined;
  if (unknown !== undefined || resolved === undefined) {
    const why = unknown ?? `no tsconfig.json exists at or above '${context.packageDir}' inside the analysis root, where its walk upward may continue`;
    addCondition(context, sink, 'TSCONFIG_INVOKED_UNKNOWN', `script "${script.name}" runs ${found.compiler} in segment ${String(segment)}, and ${why}`);
    return;
  }
  for (const [ordinal, { project, named, leaves }] of resolved.entries()) {
    const config = leaves || !context.isGitContent(named) ? null : named;
    const row: TsconfigInvocationRow = {
      root: context.root, path: context.path, script: script.name, segment, ordinal,
      package: context.name, packageDir: context.packageDir,
      compiler: found.compiler, project, config, buildMode: reading.kind === 'build', line: script.line,
    };
    sink.invocations.push(row);
    if (leaves) sink.outsideRoot.push(row);
    else if (config === null) addCondition(context, sink, 'TSCONFIG_INVOKED_MISSING', `script "${script.name}" names ${named}, which is not git content`);
  }
}

/**
 * @param input - One `package.json`'s rows, the compiler set and git membership
 * @returns Its invocation rows, `TSCONFIG_INVOKED_MISSING` conditions and outside-root marks
 */
export function invocationsOf(input: InvocationInput): InvocationResult {
  const slash = input.path.lastIndexOf('/');
  const { name, scripts } = readPackage(input.nodes);
  const context: Context = { ...input, packageDir: slash < 0 ? '.' : input.path.slice(0, slash), name };
  const sink: Sink = { invocations: [], conditions: [], outsideRoot: [] };
  for (const script of scripts) {
    let directoryKnown = true;
    for (const [segment, text] of script.command.split(SEGMENT_SPLIT).entries()) {
      const tokens = tokensOf(text);
      readSegment(context, script, segment, tokens, directoryKnown, sink);
      if (DIRECTORY_COMMANDS.has(tokens[0] ?? '')) directoryKnown = false;
    }
  }
  return sink;
}
