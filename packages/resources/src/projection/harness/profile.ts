/**
 * The harness abstraction: one coding-tool's own vocabulary for what it loads
 * into context, and the four questions every later table and lazy pass are
 * built on top of — is a path an entry point, does it read a path at all, what
 * does it do with one file's bytes, and how does it resolve and render one.
 *
 * VAT reads on behalf of a harness rather than owning a generic memory-file
 * model of its own: `CLAUDE.md`, `.claude/rules` and `@` imports are Claude
 * Code's vocabulary, transcribed from the shipped binary
 * (`docs/external/claude-code-memory-loader.md`), not a VAT invention another
 * harness would coincidentally share. A second harness gets a second profile
 * beside {@link CLAUDE_CODE} in {@link HARNESS_PROFILES}; nothing here assumes
 * there is only ever one.
 *
 * This module holds only the shape — the types, the registry and the two
 * lookups. `harness/claude-code.ts` holds the one profile that exists today.
 */

import type { ReferenceDialect } from '../../schemas/project-config.js';
import type { ResolveLocalHrefResult } from '../../utils.js';

import { CLAUDE_CODE } from './claude-code.js';

/** A harness this package knows how to read on behalf of. */
export type HarnessId = 'claude-code';

/** Which loader branch put a file in context; decides the render header. */
export type MemoryKind = 'Project' | 'Local';

/** How the file entered: at session launch, or when a file was read. */
export type LoadTrigger = 'launch' | 'read';

/** `path` when an import target names a directory component, else `bare`. */
export type ImportShape = 'path' | 'bare';

/** One `@` import, before anything resolves it against a path. */
export interface HarnessImport {
  /** The token as authored, `@` included. */
  readonly rawRef: string;
  /** The spelling the harness resolves: unescaped, fragment cut. */
  readonly target: string;
  /** 1-based line of the `@` — see `HarnessBlobImportRowSchema.line` for where it is approximate. */
  readonly line: number;
}

/** Everything the harness does with one file's bytes. */
export interface HarnessContentFacts {
  /** UTF-8 bytes of the injected text; 0 when the harness injects nothing. */
  readonly injectedBytes: number;
  /** The token estimate of the injected text. */
  readonly injectedTokens: number;
  /** Every import, first occurrence of each target, in document order. */
  readonly imports: readonly HarnessImport[];
  /** The `paths:` globs, verbatim — null when the harness scopes the file by none. */
  readonly paths: readonly string[] | null;
}

/**
 * One coding harness's own reading of memory files — the entry points it
 * opens without being imported, the text-file test, what it does with a
 * file's bytes, how it resolves and renders one, and the bounds it imposes.
 */
export interface HarnessProfile {
  readonly id: HarnessId;
  /** The config dialect whose edges this harness reads. */
  readonly dialect: Exclude<ReferenceDialect, 'href'>;
  /** Hops an import chain may take from a loaded root; the root is hop 0. */
  readonly maxImportDepth: number;
  /** Files larger than this are never read. */
  readonly sizeCliffBytes: number;
  /** Per-directory memory files, in the order the launch walk reads them (rules slot in after index 1). */
  readonly entryNames: { readonly project: readonly string[]; readonly local: string; readonly rulesDirectory: string; readonly ruleExtension: string };
  /** Whether a root-relative path is a memory file the loader reads without being imported. */
  isEntryPoint(rootRelativePath: string): boolean;
  /** Whether the loader reads a file at this path at all (`Syn`). */
  isTextPath(path: string): boolean;
  /** Everything the harness does with one file's bytes. */
  factsOf(raw: string): HarnessContentFacts;
  /** Resolve one import target against the importing file. */
  resolveImport(target: string, sourceFilePath: string): ResolveLocalHrefResult;
  /** `path` when the target names a directory component, else `bare`. */
  importShape(target: string): ImportShape;
  /** The header the harness renders before one file's content (`Contents of …:\n`); the inter-file joiner is not included. */
  renderHeader(absolutePath: string, kind: MemoryKind, trigger: LoadTrigger): string;
  /** The text rendered once before all launch files; '' when none loaded. */
  readonly launchPreamble: string;
}

/** Every harness profile this package knows, keyed by {@link HarnessId}. */
export const HARNESS_PROFILES: Readonly<Record<HarnessId, HarnessProfile>> = {
  'claude-code': CLAUDE_CODE,
};

/**
 * Look up a harness profile by id.
 *
 * @param id - The harness id
 * @returns Its profile
 */
export function harnessById(id: HarnessId): HarnessProfile {
  return HARNESS_PROFILES[id];
}

/**
 * Look up the harness profile that reads a declared config dialect's edges.
 *
 * @param dialect - A declared, non-`href` {@link ReferenceDialect}
 * @returns Its profile
 * @throws When no profile declares this dialect — unreachable through the
 *   schema, which admits only dialects a profile below claims
 */
export function harnessForDialect(dialect: Exclude<ReferenceDialect, 'href'>): HarnessProfile {
  const found = Object.values(HARNESS_PROFILES).find((profile) => profile.dialect === dialect);
  if (found === undefined) throw new Error(`No harness profile declares the "${dialect}" dialect.`);
  return found;
}
