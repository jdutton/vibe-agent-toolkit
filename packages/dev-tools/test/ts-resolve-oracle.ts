/**
 * The compiler oracle of the resolved import graph, the
 * relation as the built `vat resources query` answers it, and the comparison of the two, both ways.
 *
 * **The oracle** is a `Program` per demanded config, built with the module the BUILT
 * `loadVendoredTypeScript()` returns (the step's own loader, so a difference is a defect in the step
 * and never a version skew; the project's `typescript` is a type-only import here), on the real file
 * system. Its program files are every git-content file of the program, declaration files included,
 * but the excluded ones below. Per program file, it reads:
 *
 * - every module usage TypeScript collected (`imports`, and the string-named `moduleAugmentations`),
 *   its mode (`getModeForUsageLocation`) and its resolution (`getResolvedModule`);
 * - every `/// <reference types>` (`getResolvedTypeReferenceDirectiveFromTypeReferenceDirective`, mode
 *   `resolutionMode` else `getDefaultResolutionModeForFile`, which is `getModeForTypeReferenceDirectiveInFile`);
 * - every `/// <reference path>` (`getSourceFileFromReference`).
 *
 * **The emit record.** Each emitting program is emitted in memory (a `writeFile` callback, nothing
 * written): its `sourceFiles` argument maps each actual output to its input, and every oracle target
 * that is an output is mapped through that record, never through the step's map. The emit runs on a
 * program built with `noCheck` added, from the resolving program as `oldProgram` where there is one
 * (TypeScript then reuses every source file): `noCheck` moves no output name and no resolution, and
 * spares a type check of every program. A bundle (`outFile`) has no per-file outputs, so
 * it is not emitted. With `inMemoryBuild` every emitting config is emitted first and the oracle's
 * host then serves those outputs as files (the fixture corpus, built in memory); without it the
 * outputs on disk are the build (this repository after `bun run build`).
 *
 * **Excluded, by name and counted:** implicit imports (a synthesized `tslib` or `jsx-runtime` import is
 * built by the node factory, so its `pos` is negative); automatic type directives (they add files to a
 * program and are no reference of any file: `automaticTypeDirectives` counts their names), and every
 * git-content file the program holds only through them, the `types` option's entries included, or
 * only through such a file (`typesOnly`, files: the relation walks from root files only, so such a
 * file is neither read for references nor a program file); every git-content file the program
 * holds as an external library (`throughMember`, files: TypeScript's own
 * `isSourceFileFromExternalLibrary`, a file reached through a member link, which the relation
 * records as a leaf and never walks, so a member no demanded config compiles is in no program of
 * the relation); `/// <reference lib>` (the relation's `lib`, never
 * resolved); and oracle resolutions of a member the importing file's owning manifest does not
 * declare (an install that links every member at the root resolves what the relation classes
 * `memberUndeclared`; {@link compareWithOracle} asserts each lands in the member the row names); and
 * every file a program holds only past a project reference's declaration output. tsc reads a
 * referenced project's root file as its `.d.ts` output (`path` the source, `resolvedPath` the
 * output) and resolves that output's references from the source's place, so the program can hold
 * a git-content file (the referenced project's own `.d.ts`) that only an output references. The
 * relation records such a source as a `file` leaf and, as for a member, never reads past it, so
 * a file every one of whose include reasons is a reference from an output, or from a file so
 * excluded, is neither read for references nor a program file.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';

import { canonicalPath, mkdirSyncReal, relativeEscapesRoot, safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import type ts from 'typescript';

import { byText, REPO_ROOT, vatQuery } from './check-port-differential.js';

type TypeScript = typeof ts;

/** A file of a config's program, as one key. */
export function fileKey(config: string, path: string): string {
  return `${config} ${path}`;
}

/** The reference kinds compared; `referenceLib` is excluded by name. */
export const COMPARED_KINDS = [
  'import', 'export', 'importEquals', 'dynamic', 'importType', 'require',
  'jsdocImport', 'jsdocImportType', 'ambient', 'referencePath', 'referenceTypes',
] as const;

type ComparedKind = (typeof COMPARED_KINDS)[number];

/** A reference's mode, as the relation spells it. */
export type Mode = 'import' | 'require' | null;

/** Where an oracle resolution landed, after the emit mapping. */
type OracleTarget =
  | { readonly kind: 'unresolved' }
  /** Git content: a source, or an output the emit record maps back to its one input. */
  | { readonly kind: 'git'; readonly path: string }
  /** An output two inputs claim (two configs, or `x.ts` and `x.tsx`). */
  | { readonly kind: 'ambiguous'; readonly sources: readonly string[] }
  /** Under a `node_modules`, or outside the tree, and no output of any demanded config: third-party code. */
  | { readonly kind: 'thirdParty'; readonly path: string }
  /** Inside the tree, not git content, no output of any demanded config: kept visible, never matched. */
  | { readonly kind: 'notGit'; readonly path: string };

/** One reference as the compiler resolved it. */
export interface OracleReference {
  readonly config: string;
  readonly path: string;
  readonly kind: ComparedKind;
  readonly specifier: string;
  readonly mode: Mode;
  readonly target: OracleTarget;
}

/** What the oracle answered over one tree. */
export interface OracleAnswer {
  readonly references: readonly OracleReference[];
  /** Per config, its program's git-content files but the excluded ones, sorted. */
  readonly programFiles: Readonly<Record<string, readonly string[]>>;
  /** The exclusions the oracle alone counts (the member one needs the relation: {@link compareWithOracle}). */
  readonly excluded: OracleExclusions;
  /** Each walked file's implied node format as a mode, by {@link fileKey}: the forced-mode control reads it. */
  readonly impliedFormat: ReadonlyMap<string, Mode>;
}

/** The exclusions {@link oracleOf} counts: references (`implicit`, `referenceLib`), names (`automaticTypeDirectives`) and files (the rest). */
export interface OracleExclusions {
  readonly implicit: number;
  readonly automaticTypeDirectives: number;
  readonly referenceLib: number;
  readonly pastReferenceOutput: number;
  readonly typesOnly: number;
  readonly throughMember: number;
}

/** The internals a `Program` carries that the public typings leave out. */
interface ProgramInternals {
  getResolvedModule(file: ts.SourceFile, name: string, mode: ts.ResolutionMode): { readonly resolvedModule?: { readonly resolvedFileName: string } } | undefined;
  getResolvedTypeReferenceDirectiveFromTypeReferenceDirective(ref: ts.FileReference, file: ts.SourceFile): { readonly resolvedTypeReferenceDirective?: { readonly resolvedFileName?: string } } | undefined;
  getDefaultResolutionModeForFile(file: ts.SourceFile): ts.ResolutionMode;
  getSourceFileFromReference(file: ts.SourceFile, ref: ts.FileReference): ts.SourceFile | undefined;
  getAutomaticTypeDirectiveNames(): readonly string[];
  getFileIncludeReasons(): ReadonlyMap<string, ReadonlyArray<{ readonly kind: number; readonly file?: string }>>;
}

/** The include-reason kinds (`FileIncludeKind`, internal) of a reference from another file. */
interface IncludeKindInternals {
  readonly FileIncludeKind: { readonly Import: number; readonly ReferenceFile: number; readonly TypeReferenceDirective: number; readonly AutomaticTypeDirectiveFile: number };
}

/** The internals a `SourceFile` carries that the public typings leave out. */
interface SourceFileInternals {
  readonly imports: readonly ts.StringLiteralLike[];
  readonly moduleAugmentations: ReadonlyArray<ts.StringLiteral | ts.Identifier>;
  /** The file's canonical name: the include reasons' key. */
  readonly path: string;
  /** The output tsc read in place of a referenced project's source; `path` stays the source's. */
  readonly resolvedPath: string;
}

/**
 * The vendored TypeScript, through the BUILT loader of `resources`, the one the step calls.
 *
 * @returns The module
 */
export async function loadOracleTypeScript(): Promise<TypeScript> {
  const loader = safePath.join(REPO_ROOT, 'packages/resources/dist/vendored-typescript.js');
  const { loadVendoredTypeScript } = (await import(pathToFileURL(loader).href)) as { loadVendoredTypeScript: () => Promise<TypeScript> };
  return loadVendoredTypeScript();
}

/**
 * The tree's git content, as the relation's listing reads it: tracked, plus untracked and not ignored.
 *
 * @param root - The tree
 * @returns Root-relative paths
 */
function gitContentOf(root: string): ReadonlySet<string> {
  const result = spawnSync(gitExecutable(), ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return new Set(result.stdout.split(String.fromCodePoint(0)).filter((path) => path.length > 0));
}

/**
 * Make the links an isolated install presents, as real directory symlinks (junctions on Windows),
 * ignored through `.git/info/exclude`, so they are no git content, as an install's never are.
 *
 * @param root - A git work tree
 * @param links - Link path to target directory, root-relative
 */
export function writeInstallLinks(root: string, links: Readonly<Record<string, string>>): void {
  for (const [link, target] of Object.entries(links)) {
    const at = safePath.join(root, link);
    mkdirSyncReal(safePath.join(at, '..'), { recursive: true });
    // eslint-disable-next-line local/no-bare-symlink-in-tests -- a junction on win32 needs no privilege and a POSIX directory link never does, so no host is out of scope and no capability skip applies: an isolated install's links are this subject's input
    symlinkSync(safePath.join(root, target), at, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const exclude = safePath.join(root, '.git/info/exclude');
  const before = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : '';
  writeFileSync(exclude, `${before}node_modules/\n`);
}

/** Path to its canonical spelling (a missing path from its deepest existing ancestor: a link's answer for a path held in memory only), memoized. */
function canonicalizer(): (path: string) => string {
  const memo = new Map<string, string>();
  return (path) => {
    const known = memo.get(path);
    if (known !== undefined) return known;
    const answer = canonicalPath(path, path);
    memo.set(path, answer);
    return answer;
  };
}

/** The outputs of the demanded configs' emits: output to its inputs, and (in memory) its text. */
class EmitRecord {
  readonly sources = new Map<string, Set<string>>();
  readonly texts = new Map<string, string>();
  readonly directories = new Set<string>();

  constructor(private readonly canonical: (path: string) => string, private readonly relative: (path: string) => string) {}

  /** The `writeFile` callback of one emit; `keepText` serves the outputs to a later program. */
  writer(keepText: boolean): ts.WriteFileCallback {
    return (fileName, text, _bom, _onError, sourceFiles) => {
      if (sourceFiles === undefined || sourceFiles.length === 0) return;
      const output = this.canonical(fileName);
      const sources = this.sources.get(output) ?? new Set<string>();
      for (const source of sourceFiles) sources.add(this.relative(source.fileName));
      this.sources.set(output, sources);
      if (!keepText || output.endsWith('.map')) return;
      this.texts.set(output, text);
      for (let at = safePath.join(output, '..'); !this.directories.has(at); at = safePath.join(at, '..')) {
        this.directories.add(at);
        if (safePath.join(at, '..') === at) break;
      }
    };
  }
}

/** A compiler host on the real file system that also serves the in-memory build's outputs. */
function hostServing(typescript: TypeScript, options: ts.CompilerOptions, record: EmitRecord, canonical: (path: string) => string): ts.CompilerHost {
  const host = typescript.createCompilerHost(options);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const directoryExists = host.directoryExists?.bind(host) ?? ((): boolean => false);
  host.fileExists = (path) => fileExists(path) || record.texts.has(canonical(path));
  host.readFile = (path) => readFile(path) ?? record.texts.get(canonical(path));
  host.directoryExists = (path) => directoryExists(path) || record.directories.has(canonical(path));
  host.realpath = canonical;
  return host;
}

/** A demanded config, parsed by the compiler from the real file system. */
function parseConfig(typescript: TypeScript, root: string, config: string): ts.ParsedCommandLine {
  const parsed = typescript.getParsedCommandLineOfConfigFile(safePath.join(root, config), undefined, {
    ...typescript.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(`${config}: ${typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    },
  });
  if (parsed === undefined) throw new Error(`${config}: the compiler parsed nothing`);
  return parsed;
}

/** Whether TypeScript writes per-file outputs for a config: not `noEmit`, not a bundle. */
function emitsPerFile(parsed: ts.ParsedCommandLine): boolean {
  return parsed.options.noEmit !== true && parsed.options.outFile === undefined;
}

/** A program over `parsed`, optionally with `noCheck` (for the emit) and an old program to reuse. */
function programOf(typescript: TypeScript, parsed: ts.ParsedCommandLine, host: ts.CompilerHost, emit: { readonly from?: ts.Program } | undefined): ts.Program {
  return typescript.createProgram({
    rootNames: parsed.fileNames,
    options: emit === undefined ? parsed.options : { ...parsed.options, noCheck: true },
    ...(parsed.projectReferences === undefined ? {} : { projectReferences: parsed.projectReferences }),
    host,
    ...(emit?.from === undefined ? {} : { oldProgram: emit.from }),
  });
}

/** A compiler resolution mode as the relation spells it. */
function modeOf(typescript: TypeScript, mode: ts.ResolutionMode): Mode {
  if (mode === typescript.ModuleKind.ESNext) return 'import';
  if (mode === typescript.ModuleKind.CommonJS) return 'require';
  return null;
}

/** Whether a node was parsed from a JSDoc comment rather than from code. */
function isJsDocNode(typescript: TypeScript, node: ts.Node): boolean {
  const jsDocBits = node.flags & typescript.NodeFlags.JSDoc;
  return jsDocBits !== 0;
}

/** The relation's `kind` of a module usage TypeScript collected, by its syntactic parent. */
function usageKind(typescript: TypeScript, usage: ts.StringLiteralLike): ComparedKind {
  const parent = usage.parent;
  if (typescript.isImportDeclaration(parent)) return 'import';
  if (typescript.isJSDocImportTag(parent)) return 'jsdocImport';
  if (typescript.isExportDeclaration(parent)) return 'export';
  if (typescript.isExternalModuleReference(parent)) return 'importEquals';
  if (typescript.isModuleDeclaration(parent)) return 'ambient';
  if (typescript.isCallExpression(parent)) return parent.expression.kind === typescript.SyntaxKind.ImportKeyword ? 'dynamic' : 'require';
  if (typescript.isLiteralTypeNode(parent) && typescript.isImportTypeNode(parent.parent)) {
    return isJsDocNode(typescript, parent.parent) ? 'jsdocImportType' : 'importType';
  }
  throw new Error(`an import TypeScript collected under a ${typescript.SyntaxKind[parent.kind]}: '${usage.text}'`);
}

/** One reference before its target is mapped: the target is the compiler's absolute answer. */
interface RawReference extends Omit<OracleReference, 'target'> {
  readonly resolved: string | undefined;
}

/** Counters the walk adds to. */
type Counts = { -readonly [Name in keyof OracleExclusions]: number };

/** The module usages of one file, mode and resolution as the program answered them. */
function moduleUsages(typescript: TypeScript, program: ts.Program, file: ts.SourceFile, at: { readonly config: string; readonly path: string }, counts: Counts): RawReference[] {
  const internals = program as unknown as ProgramInternals;
  const { imports, moduleAugmentations } = file as unknown as SourceFileInternals;
  const usages = [...imports, ...moduleAugmentations.filter((name): name is ts.StringLiteral => typescript.isStringLiteral(name))];
  return usages.flatMap((usage) => {
    if (usage.pos < 0) {
      counts.implicit += 1;
      return [];
    }
    const mode = program.getModeForUsageLocation(file, usage);
    const resolved = internals.getResolvedModule(file, usage.text, mode)?.resolvedModule?.resolvedFileName;
    return [{ ...at, kind: usageKind(typescript, usage), specifier: usage.text, mode: modeOf(typescript, mode), resolved }];
  });
}

/** The triple-slash `types` and `path` references of one file. */
function directives(typescript: TypeScript, program: ts.Program, file: ts.SourceFile, at: { readonly config: string; readonly path: string }, counts: Counts): RawReference[] {
  const internals = program as unknown as ProgramInternals;
  counts.referenceLib += file.libReferenceDirectives.length;
  const types = file.typeReferenceDirectives.map((ref): RawReference => ({
    ...at,
    kind: 'referenceTypes',
    specifier: ref.fileName,
    mode: modeOf(typescript, ref.resolutionMode ?? internals.getDefaultResolutionModeForFile(file)),
    resolved: internals.getResolvedTypeReferenceDirectiveFromTypeReferenceDirective(ref, file)?.resolvedTypeReferenceDirective?.resolvedFileName,
  }));
  const paths = file.referencedFiles.map((ref): RawReference => ({
    ...at, kind: 'referencePath', specifier: ref.fileName, mode: null, resolved: internals.getSourceFileFromReference(file, ref)?.fileName,
  }));
  return [...types, ...paths];
}

/** Everything one program contributes to the answer. */
interface ProgramReading {
  readonly references: RawReference[];
  readonly programFiles: string[];
}

/** Read one resolving program: its references, its git-content files but the excluded ones, the implied formats. */
function readProgram(
  typescript: TypeScript, program: ts.Program, config: string,
  tree: { readonly git: ReadonlySet<string>; readonly relative: (path: string) => string },
  sinks: { readonly counts: Counts; readonly impliedFormat: Map<string, Mode> },
): ProgramReading {
  sinks.counts.automaticTypeDirectives += (program as unknown as ProgramInternals).getAutomaticTypeDirectiveNames().length;
  const references: RawReference[] = [];
  const programFiles: string[] = [];
  const pastOutput = pastReferenceOutput(typescript, program);
  const typesOnly = heldOnlyThroughTypes(typescript, program);
  for (const file of program.getSourceFiles()) {
    const path = tree.relative(file.fileName);
    if (!tree.git.has(path)) continue;
    const exclusion = exclusionOf(program, file as ts.SourceFile & SourceFileInternals, { pastOutput, typesOnly });
    if (exclusion !== undefined) {
      sinks.counts[exclusion] += 1;
      continue;
    }
    programFiles.push(path);
    sinks.impliedFormat.set(fileKey(config, path), modeOf(typescript, file.impliedNodeFormat));
    const at = { config, path };
    references.push(...moduleUsages(typescript, program, file, at, sinks.counts), ...directives(typescript, program, file, at, sinks.counts));
  }
  return { references, programFiles: programFiles.toSorted(byText) };
}

/** Which file exclusion, if any, a git-content program file falls under. */
function exclusionOf(
  program: ts.Program,
  file: ts.SourceFile & SourceFileInternals,
  sets: { readonly pastOutput: ReadonlySet<string>; readonly typesOnly: ReadonlySet<string> },
): 'pastReferenceOutput' | 'typesOnly' | 'throughMember' | undefined {
  if (sets.pastOutput.has(file.path)) return 'pastReferenceOutput';
  if (sets.typesOnly.has(file.path)) return 'typesOnly';
  return program.isSourceFileFromExternalLibrary(file) ? 'throughMember' : undefined;
}

/**
 * The files a program holds only through `sources`: every include reason is one `held` accepts, or a
 * reference (an import, a `/// <reference path>`, a `/// <reference types>`) from a file in `sources`
 * or already in the set, to a fixed point. A root file or a lib is never in it.
 *
 * @param typescript - The vendored module, for `FileIncludeKind`
 * @param program - The resolving program
 * @param sources - The files whose references put a file in the set (never in it themselves)
 * @param held - An include reason that puts a file in the set on its own
 * @returns The files' `path`s
 */
function heldOnlyThrough(typescript: TypeScript, program: ts.Program, sources: ReadonlySet<string>, held: (kind: number) => boolean): ReadonlySet<string> {
  const reasons = (program as unknown as ProgramInternals).getFileIncludeReasons();
  const kinds = (typescript as unknown as IncludeKindInternals).FileIncludeKind;
  const referenceKinds = new Set([kinds.Import, kinds.ReferenceFile, kinds.TypeReferenceDirective]);
  const files = program.getSourceFiles() as ReadonlyArray<ts.SourceFile & SourceFileInternals>;
  const past = new Set<string>();
  const accepts = (reason: { readonly kind: number; readonly file?: string }): boolean =>
    held(reason.kind) || (referenceKinds.has(reason.kind) && reason.file !== undefined && (sources.has(reason.file) || past.has(reason.file)));
  for (let grew = true; grew;) {
    grew = false;
    for (const file of files) {
      if (sources.has(file.path) || past.has(file.path)) continue;
      const each = reasons.get(file.path) ?? [];
      if (each.length === 0 || !each.every((reason) => accepts(reason))) continue;
      past.add(file.path);
      grew = true;
    }
  }
  return past;
}

/**
 * The files a program holds only past a project reference's declaration output: every include
 * reason is a reference from a substituted output (`resolvedPath` is not `path`) or from a file
 * already in the set. A root file, a lib or an automatic type directive is never in it.
 */
function pastReferenceOutput(typescript: TypeScript, program: ts.Program): ReadonlySet<string> {
  const files = program.getSourceFiles() as ReadonlyArray<ts.SourceFile & SourceFileInternals>;
  return heldOnlyThrough(typescript, program, new Set(files.filter((file) => file.resolvedPath !== file.path).map((file) => file.path)), () => false);
}

/**
 * The files a program holds only through an automatic type directive (the `types` option's entries
 * among them) or a file so held: the relation's walk starts from root files only, so it never reads
 * one, which the hazard register records.
 */
function heldOnlyThroughTypes(typescript: TypeScript, program: ts.Program): ReadonlySet<string> {
  const { AutomaticTypeDirectiveFile } = (typescript as unknown as IncludeKindInternals).FileIncludeKind;
  return heldOnlyThrough(typescript, program, new Set(), (kind) => kind === AutomaticTypeDirectiveFile);
}

/**
 * The compiler's answer over one tree, for the demanded configs.
 *
 * @param typescript - The vendored module ({@link loadOracleTypeScript})
 * @param tree - The tree (a real path) and how it is built
 * @param tree.root - The tree's root, as a real path
 * @param tree.inMemoryBuild - Emit every emitting config first and serve its outputs as files
 * @param configs - The demanded configs, root-relative
 * @returns The references, program files and exclusions
 */
export function oracleOf(typescript: TypeScript, tree: { readonly root: string; readonly inMemoryBuild: boolean }, configs: readonly string[]): OracleAnswer {
  const { root, inMemoryBuild } = tree;
  const git = gitContentOf(root);
  const canonical = canonicalizer();
  const relative = (path: string): string => safePath.relative(root, canonical(path));
  const record = new EmitRecord(canonical, relative);
  const parsed = configs.map((config) => [config, parseConfig(typescript, root, config)] as const);
  if (inMemoryBuild) {
    for (const [, each] of parsed.filter(([, candidate]) => emitsPerFile(candidate))) {
      programOf(typescript, each, typescript.createCompilerHost(each.options), {}).emit(undefined, record.writer(true));
    }
  }
  const counts: Counts = { implicit: 0, automaticTypeDirectives: 0, referenceLib: 0, pastReferenceOutput: 0, typesOnly: 0, throughMember: 0 };
  const impliedFormat = new Map<string, Mode>();
  const raw: RawReference[] = [];
  const programFiles: Record<string, readonly string[]> = {};
  for (const [config, each] of parsed) {
    const host = inMemoryBuild ? hostServing(typescript, each.options, record, canonical) : typescript.createCompilerHost(each.options);
    const program = programOf(typescript, each, host, undefined);
    if (!inMemoryBuild && emitsPerFile(each)) programOf(typescript, each, host, { from: program }).emit(undefined, record.writer(false));
    const reading = readProgram(typescript, program, config, { git, relative }, { counts, impliedFormat });
    raw.push(...reading.references);
    programFiles[config] = reading.programFiles;
  }
  const targetOf = (resolved: string | undefined): OracleTarget => mappedTarget(resolved, { canonical, relative, git, record });
  return {
    references: raw.map(({ resolved, ...reference }) => ({ ...reference, target: targetOf(resolved) })),
    programFiles,
    excluded: counts,
    impliedFormat,
  };
}

/** An absolute compiler answer, through the emit record, as an {@link OracleTarget}. */
function mappedTarget(
  resolved: string | undefined,
  tree: { readonly canonical: (path: string) => string; readonly relative: (path: string) => string; readonly git: ReadonlySet<string>; readonly record: EmitRecord },
): OracleTarget {
  if (resolved === undefined) return { kind: 'unresolved' };
  const sources = tree.record.sources.get(tree.canonical(resolved));
  if (sources !== undefined) {
    const [only, ...more] = [...sources].toSorted(byText);
    return more.length === 0 && only !== undefined ? { kind: 'git', path: only } : { kind: 'ambiguous', sources: [...sources].toSorted(byText) };
  }
  const path = tree.relative(resolved);
  if (tree.git.has(path)) return { kind: 'git', path };
  if (relativeEscapesRoot(path) || `/${path}/`.includes('/node_modules/')) return { kind: 'thirdParty', path };
  return { kind: 'notGit', path };
}

// ── The relation ────────────────────────────────────────────────────────────

/** A `ts_import_targets` row, as far as the comparison reads it. */
export interface RelationTarget {
  readonly config: string;
  readonly path: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly specifier: string;
  readonly mode: Mode;
  readonly targetKind: string;
  readonly target: string | null;
  readonly package: string | null;
  readonly pathsMatched: number;
  readonly redirected: number;
}

/** The three relations, and the demanded configs, as `vat resources query` answered them. */
export interface RelationAnswer {
  readonly targets: readonly RelationTarget[];
  readonly programFiles: ReadonlyArray<{ readonly config: string; readonly path: string }>;
  readonly conditions: ReadonlyArray<{ readonly config: string | null; readonly path: string | null; readonly ordinal: number | null; readonly code: string }>;
  /** `tsconfig_configs`: the demanded configs, from the tsconfig family, not from the three. */
  readonly configs: readonly string[];
}

/** One statement, tagged rows as JSON text: one `vat` process answers all four. */
const RELATION_SQL = [
  "SELECT 'target' AS tag, json_object('config', config, 'path', path, 'ordinal', ordinal, 'kind', kind, 'specifier', specifier, 'mode', mode, " +
    "'targetKind', targetKind, 'target', target, 'package', package, 'pathsMatched', pathsMatched, 'redirected', redirected) AS v FROM ts_import_targets",
  "SELECT 'program', json_object('config', config, 'path', path) FROM ts_program_files",
  "SELECT 'condition', json_object('config', config, 'path', path, 'ordinal', ordinal, 'code', code) FROM ts_import_conditions",
  "SELECT 'config', json_object('path', path) FROM tsconfig_configs",
].join(' UNION ALL ');

/**
 * The relation over `root`, computed by the built `vat resources query`.
 *
 * @param root - The tree
 * @param cacheDir - The `VAT_CACHE_DIR` of the run
 * @returns The rows
 */
export async function relationOf(root: string, cacheDir: string): Promise<RelationAnswer> {
  const rows = await vatQuery(root, cacheDir, RELATION_SQL);
  const of = <T>(tag: string): T[] => rows.filter((row) => row['tag'] === tag).map((row) => JSON.parse(String(row['v'])) as T);
  return {
    targets: of<RelationTarget>('target'),
    programFiles: of<{ config: string; path: string }>('program'),
    conditions: of<{ config: string | null; path: string | null; ordinal: number | null; code: string }>('condition'),
    configs: of<{ path: string }>('config').map((row) => row.path).toSorted(byText),
  };
}

// ── The comparison ──────────────────────────────────────────────────────────

/** Every difference between the relation and the oracle, both ways, and what was set aside. */
export interface Comparison {
  /** Oracle references of a compared kind the relation holds no row for. */
  readonly onlyOracle: readonly string[];
  /** Relation rows of a compared kind the oracle holds no reference for. */
  readonly onlyRelation: readonly string[];
  /** One reference, two answers. */
  readonly disagree: readonly string[];
  /** Program files (git content, not excluded) only the oracle's program holds, as `config path`. */
  readonly programOnlyOracle: readonly string[];
  /** Program files only the relation holds. */
  readonly programOnlyRelation: readonly string[];
  /** The exclusions, counted; `referenceLib` on both sides, which must agree. */
  readonly excluded: Omit<OracleExclusions, 'referenceLib'> & {
    readonly referenceLib: { readonly oracle: number; readonly relation: number };
    readonly memberUndeclared: number;
  };
  /** The compared kinds of the relation rows an oracle reference was matched to and agreed with, sorted: the floor reads it. */
  readonly kinds: readonly string[];
  /** References answered by both sides. */
  readonly compared: number;
}

/**
 * The comparison's key: a reference is its config, file, kind, specifier and mode. One file can
 * hold several references under one key (two imports of one module); they are matched in order,
 * the oracle's in the order TypeScript collected them, the relation's by ordinal, so a dropped
 * or relabelled one is a difference.
 */
function keyOf(reference: { readonly config: string; readonly path: string; readonly kind: string; readonly specifier: string; readonly mode: Mode }): string {
  return `${reference.config} ${reference.path} ${reference.kind} '${reference.specifier}' ${String(reference.mode)}`;
}

/** @returns `items` grouped by `key`, each group in the order given */
function groupedBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const at = key(item);
    const group = groups.get(at);
    if (group === undefined) groups.set(at, [item]);
    else group.push(item);
  }
  return groups;
}

/** An oracle target, as a difference names it. */
function describeTarget(target: OracleTarget): string {
  switch (target.kind) {
    case 'unresolved': return 'unresolved';
    case 'ambiguous': return `ambiguous ${target.sources.join(' + ')}`;
    case 'git':
    case 'thirdParty':
    case 'notGit': return `${target.kind} ${target.path}`;
  }
}

/** Whether `file` lies in the workspace member named `name`: its nearest manifest on the way up names it. */
function inMember(root: string, file: string, name: string | null): boolean {
  for (let at = safePath.join(file, '..'); at !== '.' && at !== ''; at = safePath.join(at, '..')) {
    const manifest = safePath.join(root, at, 'package.json');
    if (existsSync(manifest)) return name !== null && (JSON.parse(readFileSync(manifest, 'utf-8')) as { name?: string }).name === name;
    if (safePath.join(at, '..') === at) break;
  }
  return false;
}

/** A bare specifier: not relative, not absolute, not a `#` import. */
function isBare(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#') && !/^[A-Za-z]:[/\\]/.test(specifier);
}

type Standing = 'agree' | 'member' | 'apart';

/** What {@link standing} needs beyond the pair: the tree, and the row keys a redirect made ambiguous. */
interface StandingContext {
  readonly root: string;
  readonly ambiguous: ReadonlySet<string>;
}

/** A `file`, `member` or `outputUnmapped` row stands with the git file the oracle names. */
function fileStanding(row: RelationTarget, oracle: OracleTarget): Standing {
  return oracle.kind === 'git' && oracle.path === row.target ? 'agree' : 'apart';
}

/** An `external` or `builtin` row: a bare, unaliased specifier of the right builtin-ness, against no workspace file. */
function bareStanding(row: RelationTarget, oracle: OracleTarget): Standing {
  const shaped = isBare(row.specifier) && row.pathsMatched === 0 && isBuiltin(row.specifier) === (row.targetKind === 'builtin');
  return shaped && (oracle.kind === 'unresolved' || oracle.kind === 'thirdParty') ? 'agree' : 'apart';
}

/** An `unresolved` row: the oracle resolved nothing, or found the output redirect ambiguous that the relation flagged. */
function unresolvedStanding(row: RelationTarget, oracle: OracleTarget, context: StandingContext): Standing {
  if (oracle.kind === 'unresolved') return 'agree';
  return oracle.kind === 'ambiguous' && context.ambiguous.has(`${String(row.config)} ${String(row.path)} ${String(row.ordinal)}`) ? 'agree' : 'apart';
}

/** A `memberUndeclared` row: the oracle resolved nothing, or resolved into the member the row names. */
function memberUndeclaredStanding(row: RelationTarget, oracle: OracleTarget, context: StandingContext): Standing {
  if (oracle.kind === 'unresolved') return 'agree';
  return oracle.kind === 'git' && inMember(context.root, oracle.path, row.package) ? 'member' : 'apart';
}

/**
 * How a relation row and the oracle's reference stand: agreeing, an excluded member resolution, or apart.
 *
 * `external` and `builtin` agree with an oracle answer of `unresolved` or `thirdParty`: the virtual
 * install holds no third-party package, so TypeScript resolves no bare name the workspace does not
 * hold, and the documented meaning of both is "a bare specifier naming no member" (`external`) or
 * a Node builtin (`builtin`), whatever an install on disk holds. That equivalence is all they get:
 * the row's specifier must be bare and matched by no `paths` key, and a `builtin` row's a Node
 * builtin by Node's own list (`isBuiltin`), an `external` row's not one, so a relative or alias
 * specifier the step mislabels is apart.
 */
function standing(row: RelationTarget, oracle: OracleTarget, context: StandingContext): Standing {
  switch (row.targetKind) {
    case 'file':
    case 'member':
    case 'outputUnmapped': return fileStanding(row, oracle);
    case 'external':
    case 'builtin': return bareStanding(row, oracle);
    case 'unresolved': return unresolvedStanding(row, oracle, context);
    case 'memberUndeclared': return memberUndeclaredStanding(row, oracle, context);
    default: return 'apart';
  }
}

/** Program files, both ways, per config. */
function programDifferences(oracle: OracleAnswer, relation: RelationAnswer): { readonly onlyOracle: string[]; readonly onlyRelation: string[] } {
  const oracleFiles = new Set(Object.entries(oracle.programFiles).flatMap(([config, paths]) => paths.map((path) => `${config} ${path}`)));
  const relationFiles = new Set(relation.programFiles.map((row) => `${row.config} ${row.path}`));
  return {
    onlyOracle: [...oracleFiles].filter((file) => !relationFiles.has(file)).toSorted(byText),
    onlyRelation: [...relationFiles].filter((file) => !oracleFiles.has(file)).toSorted(byText),
  };
}

/** What {@link compareWithOracle} accumulates across keys. */
interface Found {
  readonly onlyOracle: string[];
  readonly onlyRelation: string[];
  readonly disagree: string[];
  readonly kinds: Set<string>;
  matched: number;
  memberUndeclared: number;
}

/**
 * One key's references and rows, paired in order: the surplus on either side is one-sided, and
 * each matched pair is judged by {@link standing}.
 */
function compareKey(key: string, references: readonly OracleReference[], rows: readonly RelationTarget[], context: StandingContext, found: Found): void {
  for (const reference of references.slice(rows.length)) found.onlyOracle.push(`${key} oracle ${describeTarget(reference.target)}`);
  for (const row of rows.slice(references.length)) found.onlyRelation.push(`${key} #${String(row.ordinal)} relation ${row.targetKind}`);
  for (const [index, row] of rows.slice(0, references.length).entries()) {
    const reference = references[index];
    if (reference === undefined) continue;
    found.matched += 1;
    const verdict = standing(row, reference.target, context);
    if (verdict === 'member') found.memberUndeclared += 1;
    if (verdict === 'apart') found.disagree.push(`${key} #${String(row.ordinal)}: relation ${row.targetKind} ${String(row.target)}, oracle ${describeTarget(reference.target)}`);
    else found.kinds.add(row.kind);
  }
}

/**
 * The relation against the oracle, both ways: every oracle reference of a compared kind has a
 * relation row with the same key, matched in order, and an agreeing answer, every relation row of
 * a compared kind has an oracle reference, and the program files are equal.
 *
 * @param oracle - {@link oracleOf}'s answer
 * @param relation - {@link relationOf}'s answer, over the same tree
 * @param root - The tree, for the member exclusion's manifests
 * @returns The differences (all empty when they agree), the exclusions and the kinds compared
 */
export function compareWithOracle(oracle: OracleAnswer, relation: RelationAnswer, root: string): Comparison {
  const compared = new Set<string>(COMPARED_KINDS);
  const rowsByKey = groupedBy(relation.targets.filter((row) => compared.has(row.kind)).toSorted((left, right) => left.ordinal - right.ordinal), keyOf);
  const oracleByKey = groupedBy(oracle.references, keyOf);
  const ambiguous = new Set(relation.conditions.filter((row) => row.code === 'TS_OUTPUT_REDIRECT_AMBIGUOUS').map((row) => `${String(row.config)} ${String(row.path)} ${String(row.ordinal)}`));
  const found: Found = { onlyOracle: [], onlyRelation: [], disagree: [], kinds: new Set<string>(), matched: 0, memberUndeclared: 0 };
  for (const key of new Set([...oracleByKey.keys(), ...rowsByKey.keys()])) {
    compareKey(key, oracleByKey.get(key) ?? [], rowsByKey.get(key) ?? [], { root, ambiguous }, found);
  }
  const programs = programDifferences(oracle, relation);
  const { referenceLib, ...counted } = oracle.excluded;
  return {
    onlyOracle: found.onlyOracle.toSorted(byText),
    onlyRelation: found.onlyRelation.toSorted(byText),
    disagree: found.disagree.toSorted(byText),
    programOnlyOracle: programs.onlyOracle,
    programOnlyRelation: programs.onlyRelation,
    excluded: {
      ...counted,
      referenceLib: { oracle: referenceLib, relation: relation.targets.filter((row) => row.kind === 'referenceLib').length },
      memberUndeclared: found.memberUndeclared,
    },
    kinds: [...found.kinds].toSorted(byText),
    compared: found.matched,
  };
}
