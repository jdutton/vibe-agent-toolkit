/**
 * `tsconfig_invocations`: the TypeScript projects a repository's `package.json` scripts compile.
 * Pure: it reads one `package.json`'s `data__nodes` rows and a git-content membership predicate,
 * never the disk.
 *
 * ## Tokenisation (the guard's)
 *
 * Each script value is split on `&&`, `||` and `;`, then on whitespace. A segment compiles when one
 * of its tokens has a basename (the text after the last `/`) in the compiler set
 * (`resources.typescript.compilers`, default {@link DEFAULT_TSCONFIG_COMPILERS}), so
 * `node_modules/.bin/tsc` and `npx tsc` both compile. The tokens after the first compiler token
 * name the projects: `-p`, `--project` (or `--project=x`) takes the next token (the last one
 * wins, as tsc's does); in build mode (`-b`, `--build`) every non-flag token is a project; with
 * none the project is the package's own `tsconfig.json`. A project that does not end in `.json` is a
 * directory and resolves to its `tsconfig.json`.
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
 * (never a refusal). A project leaving the root is returned in `outsideRoot`, which the resolve step
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

/** The projects a compiling segment names, as written, and whether it ran in build mode. */
function projectsOf(args: readonly string[]): { readonly projects: readonly string[]; readonly buildMode: boolean } {
  const buildMode = args.includes('-b') || args.includes('--build');
  let project: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? '';
    if (token === '-p' || token === '--project') {
      const next = args[index + 1];
      if (next !== undefined) project = next;
      index++;
    } else if (token.startsWith('--project=')) {
      project = token.slice('--project='.length);
    } else if (!token.startsWith('-')) {
      positionals.push(token);
    }
  }
  if (project !== undefined) return { projects: [project], buildMode };
  return { projects: buildMode && positionals.length > 0 ? positionals : [''], buildMode };
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
function resolveProject(written: string, packageDir: string): Resolved {
  const absolute = written.startsWith('/');
  const base = packageDir === '.' ? [] : partsOf(packageDir);
  if (written === '') return { project: normalise([...base, TSCONFIG]), named: normalise([...base, TSCONFIG]), leaves: false };
  const project = normalise(absolute ? ['..'] : [...base, ...partsOf(written)]);
  const named = project.endsWith('.json') ? project : normalise([project, TSCONFIG]);
  return { project, named, leaves: absolute || project === '..' || project.startsWith('../') };
}

/** @returns The compiler token of a segment's tokens and the tokens after it, or undefined when it runs none */
function compilerIn(tokens: readonly string[], compilers: readonly string[]): { readonly compiler: string; readonly args: readonly string[] } | undefined {
  const at = tokens.findIndex((token) => compilers.includes(basenameOf(token)));
  return at < 0 ? undefined : { compiler: basenameOf(tokens[at] ?? ''), args: tokens.slice(at + 1) };
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

/** Read one compiling segment's projects into the sink. */
function readSegment(context: Context, script: Script, segment: number, text: string, sink: Sink): void {
  const found = compilerIn(text.split(WHITESPACE).filter((token) => token !== '').map(unquote), context.compilers);
  if (found === undefined) return;
  const { projects, buildMode } = projectsOf(found.args);
  for (const [ordinal, written] of projects.entries()) {
    const { project, named, leaves } = resolveProject(written, context.packageDir);
    const config = leaves || !context.isGitContent(named) ? null : named;
    const row: TsconfigInvocationRow = {
      root: context.root, path: context.path, script: script.name, segment, ordinal,
      package: context.name, packageDir: context.packageDir,
      compiler: found.compiler, project, config, buildMode, line: script.line,
    };
    sink.invocations.push(row);
    if (leaves) sink.outsideRoot.push(row);
    else if (config === null) {
      sink.conditions.push({
        root: context.root, path: context.path, code: 'TSCONFIG_INVOKED_MISSING', seq: sink.conditions.length,
        message: `script "${script.name}" names ${named}, which is not git content`, kind: null, reached: null,
      });
    }
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
    for (const [segment, text] of script.command.split(SEGMENT_SPLIT).entries()) {
      readSegment(context, script, segment, text, sink);
    }
  }
  return sink;
}
