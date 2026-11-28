/**
 * A `tsconfig.json` parsed by the vendored TypeScript over an in-memory tree, for tests that need a
 * real `ParsedCommandLine` (absolute options, `configFilePath`, `fileNames` from `include`) without
 * touching disk. `include` globs are expanded by TypeScript's own (internal) `matchFiles`, so the
 * file list is the one `tsc` would compute over the same tree.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

import type ts from '../../src/vendor/typescript.cjs';

/**
 * The internal `matchFiles`, absent from the public typings. Its arguments, in order: path,
 * extensions, excludes, includes, case sensitivity, current directory, depth, the entries reader and
 * `realpath` (`tsconfig-parse.ts` types each).
 */
type MatchFiles = (...args: readonly unknown[]) => string[];

/**
 * A case-sensitive in-memory `ParseConfigHost` over `files` (absolute path to text).
 *
 * @param typescript - The vendored TypeScript, whose `matchFiles` expands `include`
 * @param files - Every file in the tree, by absolute POSIX path
 * @returns The host
 */
export function inMemoryParseConfigHost(typescript: typeof ts, files: Readonly<Record<string, string>>): ts.ParseConfigHost {
  const { matchFiles } = typescript as unknown as { matchFiles: MatchFiles };
  const paths = Object.keys(files);
  const entriesOf = (directory: string): { files: string[]; directories: string[] } => {
    const prefix = directory.endsWith('/') ? directory : `${directory}/`;
    const names = paths.filter((path) => toForwardSlash(path).startsWith(prefix)).map((path) => path.slice(prefix.length));
    return {
      files: names.filter((name) => !name.includes('/')),
      directories: [...new Set(names.filter((name) => name.includes('/')).map((name) => name.slice(0, name.indexOf('/'))))],
    };
  };
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => path in files,
    readFile: (path) => files[path],
    readDirectory: (root, extensions, excludes, includes, depth) =>
      matchFiles(root, extensions, excludes, includes, true, '/', depth, entriesOf, (path: string) => path),
  };
}

/**
 * Parse the config at `configPath` (whose text must be in `files`) as `tsc -p` would.
 *
 * @param typescript - The vendored TypeScript
 * @param files - Every file in the tree, the config among them
 * @param configPath - The config's absolute path
 * @returns The parsed command line; its options carry `configFilePath` and absolute paths
 * @throws {Error} If the parse reports any diagnostic
 */
export function parseInMemoryTsconfig(typescript: typeof ts, files: Readonly<Record<string, string>>, configPath: string): ts.ParsedCommandLine {
  const host = inMemoryParseConfigHost(typescript, files);
  const text = files[configPath];
  if (text === undefined) throw new Error(`no config at ${configPath}`);
  const parsed = typescript.parseJsonConfigFileContent(JSON.parse(text), host, configPath.slice(0, configPath.lastIndexOf('/')), undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => typescript.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  return parsed;
}
