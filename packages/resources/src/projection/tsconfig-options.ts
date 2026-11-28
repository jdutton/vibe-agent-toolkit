/**
 * The compiler options of a parsed config, path options root-relative and back.
 *
 * The tsconfig parse (worker) relativizes every path option so its answer is plain data a structured
 * clone carries and no spelling depends on where the root lives; the resolve step (main thread)
 * absolutizes the same options, by the same list, to hand them to TypeScript's resolver. One module
 * owns the list and both directions, so the two cannot drift.
 *
 * It imports no TypeScript value: every function takes the loaded module as a parameter, and the
 * import below is type-only. It is therefore not a loader of the vendored TypeScript (the boundary
 * test holds that) and may be imported from either thread.
 */

import { isAbsoluteAnyPlatform, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type ts from '../vendor/typescript.cjs';

import type { TsconfigOptions } from './tsconfig-parse.js';

/** Path options TypeScript resolves but declares in no `optionDeclarations` entry. */
const UNDECLARED_PATH_OPTIONS = ['configFilePath', 'pathsBasePath'] as const;

/** A declared option, as far as the path rule reads it. */
interface OptionDeclaration {
  readonly name: string;
  readonly isFilePath?: boolean;
  readonly element?: { readonly isFilePath?: boolean };
}

/** Options with every path option absolute and `configFile` reduced to its absolute `fileName`. */
export type AbsoluteTsconfigOptions = Omit<ts.CompilerOptions, 'configFile'> & { readonly configFile?: { readonly fileName: string } };

/**
 * @returns The names of the options TypeScript resolves as paths: every declared `isFilePath`
 *   option (a string, or a list's element), and the two it resolves undeclared
 * @throws {Error} If the loaded TypeScript has no `optionDeclarations` (the parse's own load refuses first)
 */
export function pathOptionNames(typescript: typeof ts): readonly string[] {
  const { optionDeclarations } = typescript as unknown as { readonly optionDeclarations?: readonly OptionDeclaration[] };
  if (optionDeclarations === undefined || !Array.isArray(optionDeclarations)) throw new TypeError('The loaded TypeScript has no optionDeclarations, so its path options are unknown.');
  const declared: readonly OptionDeclaration[] = optionDeclarations;
  const names = declared
    .filter((declaration) => declaration.isFilePath === true || declaration.element?.isFilePath === true)
    .map((declaration) => declaration.name);
  return [...names, ...UNDECLARED_PATH_OPTIONS];
}

/** Whether a value is a parsed config's source file, or its reduced form: an object with a string `fileName`. */
function isConfigFile(value: unknown): value is { readonly fileName: string } {
  return typeof value === 'object' && value !== null && typeof (value as { fileName?: unknown }).fileName === 'string';
}

/** @returns The options with each path option (a string, or a list's strings) mapped, and `configFile` reduced to its mapped `fileName` */
function mapPaths(typescript: typeof ts, options: object, map: (path: string) => string): Record<string, unknown> {
  const { configFile, ...rest } = options as { configFile?: unknown };
  const out: Record<string, unknown> = { ...rest };
  for (const name of pathOptionNames(typescript)) {
    const value = out[name];
    if (typeof value === 'string') out[name] = map(value);
    else if (Array.isArray(value)) out[name] = value.map((item: unknown) => (typeof item === 'string' ? map(item) : item));
  }
  if (isConfigFile(configFile)) out['configFile'] = { fileName: map(configFile.fileName) };
  return out;
}

/**
 * The options with every path option root-relative and `configFile` reduced to its root-relative
 * `fileName`.
 *
 * @param typescript - The loaded TypeScript (for its option declarations)
 * @param relative - Maps an absolute path to its root-relative form (the host's, so a link maps to its member)
 * @param options - The parsed config's options
 * @returns Plain data a structured clone carries
 */
export function rootRelativeOptions(typescript: typeof ts, relative: (path: string) => string, options: ts.CompilerOptions): TsconfigOptions {
  return mapPaths(typescript, options, relative) as TsconfigOptions;
}

/**
 * The inverse of {@link rootRelativeOptions}: every path option, `configFilePath` and `pathsBasePath`
 * included, and `configFile.fileName`, back to absolute under `root`. An option outside the root
 * keeps its `..` segments through the round trip.
 *
 * @param typescript - The loaded TypeScript (for its option declarations)
 * @param options - Root-relative options
 * @param root - The analysis root, absolute
 * @returns The options with absolute paths
 */
export function absoluteOptions(typescript: typeof ts, options: TsconfigOptions, root: string): AbsoluteTsconfigOptions {
  // Joined, never resolved: `resolve` anchors a root of the other platform's form (`/repo` on Windows,
  // `C:/repo` elsewhere) at the working directory's drive or path. A root-relative path is joined to
  // the root given; a path the relativizer could not make root-relative (on Windows, another drive's)
  // arrives absolute and is kept, its native separators made forward slashes.
  return mapPaths(typescript, options, (path) => (isAbsoluteAnyPlatform(path) ? toForwardSlash(path) : safePath.join(root, path))) as AbsoluteTsconfigOptions;
}
