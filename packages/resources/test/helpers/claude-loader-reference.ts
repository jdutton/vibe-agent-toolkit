/**
 * A REFERENCE PORT of Claude Code's memory-file loader — what a session loads
 * at launch, and what reading one file adds — transcribed from the shipped
 * 2.1.280 binary. The verbatim minified source, and what each function does,
 * is `docs/external/claude-code-memory-loader.md`; every function here names
 * the minified one it transcribes.
 *
 * @vendor-claim reviewed=2026-09-23 verify=Re-extract the functions named in docs/external/claude-code-memory-loader.md from the current Claude Code binary (`strings -n 6`), diff them against that file, and update this port and that file together
 *
 * ## It shares no code with the module under test
 *
 * No import from VAT's lexer, ancestry, rules selection or accounting: the
 * point is a second, independent answer. The one shared piece is DATA — the
 * vendor's text-extension list, behind `isMemoryTextPath` — because two copies
 * of a 117-entry transcription are two places to mistype it, not two answers. It reads a tree held in memory and
 * uses what the binary itself bundles — `marked` 15.0.6 (the bundled lexer,
 * pinned exactly in `package.json`) and `node-ignore` — plus `yaml` standing in
 * for `Bun.YAML` on the simple frontmatter the generator writes.
 *
 * ## The model, and what it deliberately leaves out
 *
 * The tree's root is the filesystem root: the launch walk visits every
 * directory from it down to the working directory. The filesystem is
 * CASE-SENSITIVE and has no symlinks, `readdir` answers in code-point order
 * (the binary uses whatever order the OS returns), and there are no managed,
 * user, auto-memory or additional-directory sources, and no worktree split
 * (`X8e`). `@~/…` and `@/abs` resolve outside the tree and so never load.
 * External-include approval is an INPUT, because it is per-user state the tree
 * cannot show. The `agents-md` plugin is OFF — its flag defaults off in the
 * binary — so `AGENTS.md` loads only when imported.
 */

import ignore from 'ignore';
import { Lexer, type Token } from 'marked';
import { parseDocument } from 'yaml';

import { isMemoryTextPath } from '../../src/projection/harness/claude-code.js';

/** `g3` — every memory file larger than this many bytes is skipped whole. */
export const LOADER_SIZE_CLIFF = 4_194_304;

/** `Pyn` — `oQe` refuses depth `>= 5`: the root is depth 0, so four hops load. */
const IMPORT_DEPTH_LIMIT = 5;

/** A tree held in memory: root-relative, forward-slashed path → file content. */
export type LoaderTree = ReadonlyMap<string, string>;

/** Which loader lane admitted a file — the binary's `type`. */
export type LoaderType = 'Project' | 'Local';

/** One file the loader put in context, in the order it did. */
export interface LoadedMemoryFile {
  readonly path: string;
  readonly type: LoaderType;
  /** `q7e`'s content: frontmatter and block HTML comments removed. */
  readonly content: string;
  /** What `s1n` renders (launch) under the file's header — `content.trim()`. */
  readonly injected: string;
  /** `kyn`'s surviving `paths:` globs, or undefined when the file declares none. */
  readonly globs: readonly string[] | undefined;
  /** The file whose `@` import reached this one, or undefined for a walk root. */
  readonly parent: string | undefined;
}

/** What the tree cannot tell the loader. */
export interface LoaderOptions {
  /** `hasClaudeMdExternalIncludesApproved` — may an import leave the working directory? */
  readonly externalIncludesApproved: boolean;
}

// ── The in-memory filesystem ──────────────────────────────────────────────

function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function isDirectory(tree: LoaderTree, path: string): boolean {
  const prefix = path === '' ? '' : `${path}/`;
  // eslint-disable-next-line local/no-path-startswith -- tree paths are root-relative and forward-slashed by construction
  for (const file of tree.keys()) if (file.startsWith(prefix)) return true;
  return false;
}

/** Immediate children of a directory, in code-point order, each marked file or directory. */
function childrenOf(tree: LoaderTree, dir: string): Array<{ name: string; directory: boolean }> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const found = new Map<string, boolean>();
  for (const file of tree.keys()) {
    // eslint-disable-next-line local/no-path-startswith -- tree paths are root-relative and forward-slashed by construction
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    found.set(name, (found.get(name) ?? false) || slash >= 0);
  }
  return [...found.keys()].sort(byCodePoint).map((name) => ({ name, directory: found.get(name) ?? false }));
}

function byCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** `Gd(e, ye())` — is a path at or inside the working directory? */
function insideDirectory(path: string, dir: string): boolean {
  // eslint-disable-next-line local/no-path-startswith -- tree paths are root-relative and forward-slashed by construction
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

/**
 * `et(M, LO(n))` on a tree: `~` and absolute paths leave it, a relative one is
 * `path.resolve`d against the importing file's directory.
 *
 * @returns The root-relative target, or null when it resolves outside the tree
 */
function resolveImport(ref: string, fromDir: string): string | null {
  const trimmed = ref.trim();
  if (trimmed === '') return fromDir;
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('/')) return null;
  // eslint-disable-next-line local/no-hardcoded-path-split -- tree paths are root-relative and forward-slashed by construction
  const segments = fromDir === '' ? [] : fromDir.split('/');
  // eslint-disable-next-line local/no-hardcoded-path-split -- an authored `@` reference, POSIX-joined as `path.resolve` joins it
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

// ── Reading one file: `Cge` → `Lx` → `q7e` ──────────────────────────────────

/** `gB` and `mE`: the frontmatter splitter `ts`. The body follows the first match even when the YAML fails. */
// eslint-disable-next-line sonarjs/super-linear-regex -- the harness's own `gB`, transcribed verbatim: a faster regex would be a different splitter
const FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/;

export function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const unbommed = raw.codePointAt(0) === 0xfe_ff ? raw.slice(1) : raw;
  const match = FRONTMATTER.exec(unbommed);
  if (match === null) return { frontmatter: {}, content: raw };
  const content = unbommed.slice(match[0].length);
  // A block that fails to parse contributes no frontmatter and keeps its body split off, as `ts` does.
  const document = parseDocument(match[1] ?? '');
  const parsed: unknown = document.errors.length > 0 ? null : document.toJS();
  const frontmatter = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  return { frontmatter, content };
}

/** Brace expansion by `split(",")` of the leftmost `{…}` group. */
function braceExpand(pattern: string): string[] {
  const open = pattern.indexOf('{');
  const close = open < 0 ? -1 : pattern.indexOf('}', open);
  if (close < 0) return [pattern];
  const alternatives = pattern.slice(open + 1, close).split(',');
  return alternatives.flatMap((alternative) =>
    braceExpand(pattern.slice(0, open) + alternative.trim() + pattern.slice(close + 1)));
}

/** A string list split on commas outside braces, the way the `paths:` normaliser (`C`) splits it. */
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** `pet` — the `paths:` normaliser: arrays flatten, non-strings vanish, strings split and brace-expand. */
function normalisePaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => normalisePaths(item));
  if (typeof value !== 'string') return [];
  return splitTopLevelCommas(value).flatMap((part) => braceExpand(part));
}

/** `kyn` — the body, and the globs that make a file conditional. */
function readGlobs(raw: string): { content: string; globs: string[] | undefined } {
  const { frontmatter, content } = splitFrontmatter(raw);
  if (!frontmatter['paths']) return { content, globs: undefined };
  const globs = normalisePaths(frontmatter['paths'])
    .map((glob) => (glob.endsWith('/**') ? glob.slice(0, -3) : glob))
    .filter((glob) => glob.length > 0);
  if (globs.length === 0 || globs.every((glob) => glob === '**')) return { content, globs: undefined };
  return { content, globs };
}

/** A block-level HTML token that is a comment: `raw.trimStart()` opens `<!--` and closes `-->`. */
function isCommentBlock(token: Token): boolean {
  if (token.type !== 'html') return false;
  const opening = token.raw.trimStart();
  return opening.startsWith('<!--') && opening.includes('-->');
}

const COMMENT = /<!--[\s\S]*?-->/g;

/** `Sge` — the top-level token stream re-joined with comment blocks' comments removed. */
function stripCommentBlocks(tokens: readonly Token[]): string {
  let content = '';
  for (const token of tokens) {
    if (isCommentBlock(token)) {
      const residue = token.raw.replaceAll(COMMENT, '');
      if (residue.trim().length > 0) content += residue;
      continue;
    }
    content += token.raw;
  }
  return content;
}

/** `Ayn`'s scanner: the `@` must open the text or follow whitespace, and `\ ` is a space. */
const IMPORT_TOKEN = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

/** `Ayn`'s acceptance test on one reference, `#` fragment already cut and `\ ` unescaped. */
function isImportShaped(ref: string): boolean {
  if (ref.startsWith('./') || ref.startsWith('~/')) return true;
  if (ref.startsWith('/')) return ref !== '/';
  return !ref.startsWith('@') && !/^[#%^&*()]+/.test(ref) && /^[a-zA-Z0-9._-]/.test(ref);
}

function scanText(text: string, fromDir: string, found: Set<string | null>): void {
  for (const match of text.matchAll(IMPORT_TOKEN)) {
    const raw = match[1] ?? '';
    const hash = raw.indexOf('#');
    const target = (hash === -1 ? raw : raw.slice(0, hash)).replaceAll(String.raw`\ `, ' ');
    if (target.length === 0 || !isImportShaped(target)) continue;
    found.add(resolveImport(target, fromDir));
  }
}

/** `Ayn` — every `@` import, in document order, as root-relative targets (null: outside the tree). */
function extractImports(tokens: readonly Token[], fromDir: string): Array<string | null> {
  const found = new Set<string | null>();
  const walk = (list: readonly Token[]): void => {
    for (const token of list) {
      if (token.type === 'code' || token.type === 'codespan') continue;
      if (token.type === 'html') {
        if (isCommentBlock(token)) {
          const residue = token.raw.replaceAll(COMMENT, '');
          if (residue.trim().length > 0) scanText(residue, fromDir, found);
        }
        continue;
      }
      if (token.type === 'text') scanText((token as { text?: string }).text ?? '', fromDir, found);
      const nested = token as { tokens?: Token[]; items?: Token[] };
      if (nested.tokens !== undefined) walk(nested.tokens);
      if (nested.items !== undefined) walk(nested.items);
    }
  };
  walk(tokens);
  return [...found];
}

interface ReadResult {
  readonly content: string;
  readonly globs: string[] | undefined;
  readonly includes: Array<string | null>;
}

/** `Cge` + `Lx` + `q7e`: null when the path is no regular file, is over the cliff, or is not text. */
function readMemoryFile(tree: LoaderTree, path: string): ReadResult | null {
  const raw = tree.get(path);
  if (raw === undefined || Buffer.byteLength(raw, 'utf8') > LOADER_SIZE_CLIFF) return null;
  if (!isMemoryTextPath(path)) return null;
  const { content, globs } = readGlobs(raw);
  const hasComment = content.includes('<!--');
  const tokens = hasComment || content.includes('@') ? new Lexer({ gfm: false }).lex(content) : undefined;
  return {
    content: hasComment && tokens !== undefined ? stripCommentBlocks(tokens) : content,
    globs,
    includes: tokens === undefined ? [] : extractImports(tokens, dirnameOf(path)),
  };
}

/**
 * `Ayn` over one file as `q7e` reads it — its `@` imports in document order,
 * first occurrence of each, root-relative (null: outside the tree).
 *
 * @param tree - The files on disk
 * @param path - The file, root-relative
 * @returns The targets, or null when the harness does not read the file at all
 */
export function memoryImports(tree: LoaderTree, path: string): Array<string | null> | null {
  return readMemoryFile(tree, path)?.includes ?? null;
}

// ── The walks ─────────────────────────────────────────────────────────────

/** One walk's shared state: the tree, the session directory, and `processedPaths`. */
interface Walk {
  readonly tree: LoaderTree;
  readonly cwd: string;
  readonly processed: Set<string>;
}

/**
 * `$q` — one file and its import subtree, depth-first pre-order.
 *
 * @param external - May an import (depth > 0) leave the working directory?
 */
function loadWithImports(
  walk: Walk,
  path: string,
  type: LoaderType,
  external: boolean,
  depth = 0,
  parent?: string,
): LoadedMemoryFile[] {
  if (walk.processed.has(path) || depth >= IMPORT_DEPTH_LIMIT) return [];
  if (depth > 0 && !external && !insideDirectory(path, walk.cwd)) return [];
  walk.processed.add(path);
  const read = readMemoryFile(walk.tree, path);
  if (read === null || read.content.trim() === '') return [];
  const loaded: LoadedMemoryFile[] = [{
    path,
    type,
    content: read.content,
    injected: read.content.trim(),
    globs: read.globs,
    parent,
  }];
  for (const target of read.includes) {
    if (target === null) continue;
    if (!insideDirectory(target, walk.cwd) && !external) continue;
    loaded.push(...loadWithImports(walk, target, type, external, depth + 1, path));
  }
  return loaded;
}

/**
 * `Lke` — every `.md` under a rules directory, recursively, each rule's closure
 * filtered entry by entry on its OWN globs: unconditional entries when
 * `conditional` is false, path-scoped ones when it is true.
 */
function rulesWalk(walk: Walk, rulesDir: string, conditional: boolean, external: boolean): LoadedMemoryFile[] {
  if (!isDirectory(walk.tree, rulesDir)) return [];
  const loaded: LoadedMemoryFile[] = [];
  for (const child of childrenOf(walk.tree, rulesDir)) {
    const path = joinPath(rulesDir, child.name);
    if (child.directory) {
      loaded.push(...rulesWalk(walk, path, conditional, external));
    } else if (child.name.endsWith('.md')) {
      const closure = loadWithImports(walk, path, 'Project', external);
      loaded.push(...closure.filter((entry) => (entry.globs !== undefined) === conditional));
    }
  }
  return loaded;
}

/** Every directory from the tree root down to `dir`, root first — `$yn`'s `pt`. */
function directoriesDownTo(dir: string): string[] {
  if (dir === '') return [''];
  // eslint-disable-next-line local/no-hardcoded-path-split -- tree paths are root-relative and forward-slashed by construction
  const segments = dir.split('/');
  return ['', ...segments.map((_, index) => segments.slice(0, index + 1).join('/'))];
}

/**
 * `$yn` — what a session started in `cwd` loads at launch, in load order.
 *
 * @param tree - The files on disk
 * @param cwd - The working directory, root-relative (`''` for the root)
 * @param options - Per-user state the tree cannot show
 * @returns Every loaded file, in the order the harness renders them
 */
export function launchFiles(tree: LoaderTree, cwd: string, options: LoaderOptions): LoadedMemoryFile[] {
  const walk: Walk = { tree, cwd, processed: new Set() };
  const external = options.externalIncludesApproved;
  const loaded: LoadedMemoryFile[] = [];
  for (const dir of directoriesDownTo(cwd)) {
    loaded.push(
      ...loadWithImports(walk, joinPath(dir, 'CLAUDE.md'), 'Project', external),
      ...loadWithImports(walk, joinPath(dir, '.claude/CLAUDE.md'), 'Project', external),
      ...rulesWalk(walk, joinPath(dir, '.claude/rules'), false, external),
      ...loadWithImports(walk, joinPath(dir, 'CLAUDE.local.md'), 'Local', external),
    );
  }
  return loaded;
}

/** `mre` — drop a glob `node-ignore` cannot compile, as the harness does. */
function compilableGlobs(globs: readonly string[]): string[] {
  return globs.filter((glob) => {
    try {
      ignore().add([glob]).test('probe');
      return true;
    } catch (error) {
      // `node-ignore` compiles each pattern to a RegExp; an uncompilable one throws a SyntaxError.
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  });
}

/**
 * `y3` — the path-scoped entries under one rules directory that match `file`,
 * relative to the directory holding that `.claude/rules`.
 */
function conditionalRules(walk: Walk, holder: string, file: string): LoadedMemoryFile[] {
  const entries = rulesWalk(walk, joinPath(holder, '.claude/rules'), true, false);
  if (!insideDirectory(file, holder) || file === holder) return [];
  const relative = holder === '' ? file : file.slice(holder.length + 1);
  return entries.filter((entry) => ignore().add(compilableGlobs(entry.globs ?? [])).ignores(relative));
}

/**
 * `Abn` — a directory strictly below the working directory, when a file under it is read.
 */
function nestedDirectory(walk: Walk, dir: string, file: string): LoadedMemoryFile[] {
  const loaded = [
    ...loadWithImports(walk, joinPath(dir, 'CLAUDE.md'), 'Project', false),
    ...loadWithImports(walk, joinPath(dir, '.claude/CLAUDE.md'), 'Project', false),
    ...loadWithImports(walk, joinPath(dir, 'CLAUDE.local.md'), 'Local', false),
  ];
  const copy: Walk = { ...walk, processed: new Set(walk.processed) };
  loaded.push(...rulesWalk(copy, joinPath(dir, '.claude/rules'), false, false));
  loaded.push(...conditionalRules(walk, dir, file));
  for (const path of copy.processed) walk.processed.add(path);
  return loaded;
}

/** The tree's root as an absolute path, so `Q$r`'s string-prefix test reads as it does on disk. */
const TREE_ROOT = '/tree';

function absoluteOf(path: string): string {
  return path === '' ? TREE_ROOT : `${TREE_ROOT}/${path}`;
}

/**
 * `Q$r`'s `nestedDirs`: from the read file's directory up to the working
 * directory (exclusive), root first, keeping those whose absolute path STARTS
 * WITH the working directory's — a string prefix, so `pkg2/` counts as below
 * `pkg`, as it does in the binary.
 */
function nestedDirectories(file: string, cwd: string): string[] {
  const nested: string[] = [];
  for (let dir = dirnameOf(file); dir !== cwd && dir !== ''; dir = dirnameOf(dir)) {
    if (absoluteOf(dir).startsWith(absoluteOf(cwd))) nested.unshift(dir);
  }
  return nested;
}

/**
 * `GUt` — what reading `file` adds to a session started in `cwd`, in order,
 * minus what is already in context (`sNe`).
 *
 * @param tree - The files on disk
 * @param cwd - The working directory, root-relative
 * @param file - The file read, root-relative
 * @param inContext - Paths already loaded (the launch set, earlier reads)
 * @returns The files the read injects
 */
export function filesOnRead(
  tree: LoaderTree,
  cwd: string,
  file: string,
  inContext: ReadonlySet<string>,
): LoadedMemoryFile[] {
  const walk: Walk = { tree, cwd, processed: new Set() };
  const loaded: LoadedMemoryFile[] = [];
  const nested = nestedDirectories(file, cwd);
  for (const dir of nested) loaded.push(...nestedDirectory(walk, dir, file));
  for (const dir of directoriesDownTo(cwd)) loaded.push(...conditionalRules(walk, dir, file));
  const seen = new Set(inContext);
  return loaded.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}
