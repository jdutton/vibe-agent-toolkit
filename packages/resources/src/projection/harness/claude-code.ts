/**
 * Claude Code's own reading of memory files, transcribed from the shipped
 * binary (`docs/external/claude-code-memory-loader.md`) — the one
 * {@link HarnessProfile} this package knows today.
 *
 * @vendor-claim reviewed=2026-09-24 verify=Re-extract `g3`, `Syn`, `Pyn`/`oQe`, `et`, the preamble constant `Zr`, the per-kind suffix `en`, the launch renderer `s1n` and its preamble wrapper `hve`, and the `nested_memory:(e)=>` on-read attachment renderer from the current Claude Code binary per docs/external/claude-code-memory-loader.md § "How loaded files are rendered" (anchors `4194304`, `Codebase and user instructions are shown below`, `nested_memory:(e)=>`) and diff them against this module
 */

import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { ResolveLocalHrefResult } from '../../utils.js';
import { claudeMemoryFactsOf } from '../claude-memory.js';

import { CLAUDE_CODE_ENTRY_NAMES, CLAUDE_CODE_RULES_DIR_SEGMENTS } from './claude-code-entry-names.js';
import type { HarnessProfile, ImportShape, LoadTrigger, MemoryKind } from './profile.js';

/**
 * `Syn` — the only extensions the harness reads as a memory file. A file with
 * NO extension is read; any other is skipped with its imports. Transcribed
 * verbatim, `.R` included (the harness lowercases first, so it never matches).
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.txt', '.text', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv', '.html', '.htm', '.css',
  '.scss', '.sass', '.less', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.pyi',
  '.pyw', '.rb', '.erb', '.rake', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.c', '.cpp', '.cc',
  '.cxx', '.h', '.hpp', '.hxx', '.cs', '.swift', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.env', '.ini', '.cfg', '.conf', '.config', '.properties', '.sql', '.graphql', '.gql', '.proto', '.vue',
  '.svelte', '.astro', '.ejs', '.hbs', '.pug', '.jade', '.php', '.pl', '.pm', '.lua', '.r', '.R', '.dart',
  '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.cljc', '.edn', '.hs', '.lhs', '.elm', '.ml', '.mli',
  '.f', '.f90', '.f95', '.for', '.cmake', '.make', '.makefile', '.gradle', '.sbt', '.rst', '.adoc',
  '.asciidoc', '.org', '.tex', '.latex', '.lock', '.log', '.diff', '.patch',
]);

/**
 * `q7e`'s first test: does the harness read this path as a memory file at all?
 * Its extension — `path.extname` of the last segment, lowercased, where a
 * leading dot names a file rather than starting an extension — must be empty
 * or one of {@link TEXT_EXTENSIONS}.
 *
 * The ONE transcription of that vendor list: the launch walk
 * (`claude-context-walk.ts`) and the loader reference its differential compares
 * against both ask it, rather than keeping a second copy of 117 extensions two
 * readers could drift apart on.
 *
 * @param path - A root-relative path
 * @returns True when the harness would read it
 */
export function isMemoryTextPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const extension = dot <= 0 ? '' : base.slice(dot).toLowerCase();
  return extension === '' || TEXT_EXTENSIONS.has(extension);
}

/**
 * The hop budget the vendor documents for `@` imports — `Pyn=5; oQe` refuses
 * depth `>= 5`, so the root is depth 0 and four hops load.
 */
export const CLAUDE_IMPORT_MAX_DEPTH = 4;

/**
 * The harness's memory-file size cliff, in bytes — `g3` in the shipped reader.
 *
 * A transcribed vendor quantity cited at its use, not a VAT constant anyone bumps.
 * The comparison against it is strictly greater-than: the vendor loads a file of
 * *up to* 4 MiB in full, so a file measuring exactly this is charged.
 */
export const CLAUDE_OVERSIZE_BYTES = 4 * 1024 * 1024;

/** The token `et` expands to the home directory, alone or as a `~/` prefix. */
const HOME = '~';

/** The prefix the harness reads as filesystem-absolute and RFC 3986 reads as root-relative. */
const ABSOLUTE_PREFIX = '/';

/**
 * `et` — the harness's own resolution of one import target.
 *
 * An empty target (only whitespace survived the trim) names no file: `et`
 * answers the importing directory, which the reader skips as not a regular
 * file, so `anchor_only` keeps a directory out of the extent.
 *
 * ## 🪤 {@link homedir} makes `~/` resolution environment-dependent
 *
 * Two runs under different `HOME` values resolve the same token to different
 * paths. The dialect is in the store's reuse key; `HOME` is not. A `~/` import
 * is reported `CLOSURE_REFERENCE_OUTSIDE_ROOT` and never charged, so the
 * divergence cannot change a token count — but it can change a reported target
 * path, which is why it is recorded here and not left to be found.
 *
 * @param target - A `harness_blob_imports.target`
 * @param sourceFilePath - Absolute path of the importing file
 * @returns The resolution outcome
 */
function resolveClaudeImport(target: string, sourceFilePath: string): ResolveLocalHrefResult {
  const trimmed = target.trim();
  if (trimmed === '') return { kind: 'anchor_only' };
  // `safePath` for the separators: a raw `homedir()` is backslashed on Windows,
  // and every other branch here already returns forward slashes.
  if (trimmed === HOME) return resolvedAt(safePath.resolve(homedir()));
  if (trimmed.startsWith(`${HOME}/`)) return resolvedAt(safePath.join(homedir(), trimmed.slice(HOME.length + 1)));
  if (trimmed.startsWith(ABSOLUTE_PREFIX)) return resolvedAt(safePath.resolve(trimmed));
  return resolvedAt(safePath.resolve(dirname(sourceFilePath), trimmed));
}

/**
 * A resolved outcome with no fragment — the extractor already cut it.
 *
 * @param resolvedPath - The absolute target
 * @returns The outcome
 */
function resolvedAt(resolvedPath: string): ResolveLocalHrefResult {
  return { kind: 'resolved', resolvedPath, anchor: undefined };
}

/**
 * `q7e`'s launch/read entry points: `CLAUDE.md`, `.claude/CLAUDE.md` and
 * `CLAUDE.local.md` at any directory, and any `.claude/rules` file the rules
 * walk's `Le.name.endsWith(".md")` would open.
 *
 * ## This reach is a SUPERSET, on purpose
 *
 * `CLAUDE.md`, `CLAUDE.local.md`, the `.claude` directory segment and the
 * `.claude/rules` directory segment are all matched case-INSENSITIVELY. This
 * predicate seeds the lazy harness pass — it decides which realized paths are
 * even CANDIDATES — so it must never miss a real file because a repo was
 * authored, or is checked out, on a case-insensitive filesystem: `.CLAUDE` and
 * `.claude` are the same directory there, and folding one away here would be a
 * silent under-report, not a correctness win. Which of the matches this
 * returns actually LOAD for a given tree — one directory, not both, once a
 * case-insensitive filesystem has realized only one — is the launch/read
 * walk's judgement over the realized rows, never this function's. The rule
 * file's own `.md` extension is the one exact-case comparison, matching the
 * rules walk's `Le.name.endsWith(".md")`
 * (`docs/external/claude-code-memory-loader.md` § `Lke`), which is exact on
 * every OS.
 *
 * @param rootRelativePath - A root-relative, forward-slash-able path
 * @returns True when the harness could read this path without it being imported
 */
function isEntryPoint(rootRelativePath: string): boolean {
  const segments = toForwardSlash(rootRelativePath).split('/');
  const last = segments.at(-1);
  if (last === undefined) return false;
  const lastLower = last.toLowerCase();
  const isProjectOrLocal = lastLower === CLAUDE_CODE_ENTRY_NAMES.project[0].toLowerCase()
    || lastLower === CLAUDE_CODE_ENTRY_NAMES.local.toLowerCase();
  if (isProjectOrLocal) return true;
  return last.endsWith(CLAUDE_CODE_ENTRY_NAMES.ruleExtension) && underRulesDirectory(segments);
}

/**
 * Does a rules directory (`.claude/rules`, matched case-insensitively — see
 * {@link isEntryPoint}) sit somewhere on this path, with at least one segment
 * — the file itself, or a nested directory — after it?
 *
 * @param segments - The path's segments
 * @returns True when a `.claude/rules/…` segment run is present
 */
function underRulesDirectory(segments: readonly string[]): boolean {
  const [dotClaude, rules] = CLAUDE_CODE_RULES_DIR_SEGMENTS;
  const dotClaudeLower = dotClaude.toLowerCase();
  const rulesLower = rules.toLowerCase();
  for (let i = 0; i <= segments.length - CLAUDE_CODE_RULES_DIR_SEGMENTS.length - 1; i += 1) {
    if (segments[i]?.toLowerCase() === dotClaudeLower && segments[i + 1]?.toLowerCase() === rulesLower) return true;
  }
  return false;
}

/** `en(type)` — the launch header's per-kind suffix (2.1.281). */
function memoryKindSuffix(kind: MemoryKind): string {
  return kind === 'Project'
    ? ' (project instructions, checked into the codebase)'
    : " (user's private project instructions, not checked in)";
}

/**
 * The header rendered before one file's content. A launch entry is rendered by
 * `s1n` (`Contents of <path><en(type)>:`) and the whole launch block is
 * prefixed once by `hve` with the `Zr` preamble ({@link CLAUDE_CODE}'s
 * `launchPreamble`); a read is rendered by the `nested_memory` attachment
 * renderer, which carries no suffix and no preamble.
 *
 * @param absolutePath - The file's absolute path, as the harness renders it
 * @param kind - Which loader branch loaded it
 * @param trigger - Launch or read
 * @returns The header, `Contents of …:\n`, with no trailing content and no
 *   inter-file joiner
 */
function renderHeader(absolutePath: string, kind: MemoryKind, trigger: LoadTrigger): string {
  const suffix = trigger === 'launch' ? memoryKindSuffix(kind) : '';
  return `Contents of ${absolutePath}${suffix}:\n`;
}

/**
 * `path` when the target names a directory component (`./`, `../`, `~/`, an
 * absolute path, or any segment before a `/`), else `bare` — a lone filename
 * or username-shaped token.
 *
 * @param target - A `harness_blob_imports.target`
 * @returns The shape
 */
function importShape(target: string): ImportShape {
  return target.includes('/') ? 'path' : 'bare';
}

/** Claude Code's own reading of memory files. */
export const CLAUDE_CODE: HarnessProfile = {
  id: 'claude-code',
  dialect: 'claude-import',
  maxImportDepth: CLAUDE_IMPORT_MAX_DEPTH,
  sizeCliffBytes: CLAUDE_OVERSIZE_BYTES,
  entryNames: CLAUDE_CODE_ENTRY_NAMES,
  isEntryPoint,
  isTextPath: isMemoryTextPath,
  factsOf: claudeMemoryFactsOf,
  resolveImport: resolveClaudeImport,
  importShape,
  renderHeader,
  // `Zr` — prepended once per launch by `hve`, followed by a newline.
  launchPreamble:
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n',
};
