/**
 * What Claude Code does with a file's CONTENT when it reads it as a memory
 * file — `CLAUDE.md`, a rules file, an `@` import of any extension: the text it
 * injects, the `@` imports it follows, and the `paths:` globs it scopes the
 * file by. All three are functions of the bytes alone, so all three are blob
 * facts (`blobs.claudeInjected*`, `blob_claude_imports`, `blobs.claudePaths`);
 * which PATHS the harness reads at all, and which read a glob admits, is the
 * walk's question, never this module's.
 *
 * Transcribed from the shipped reader — `q7e` (content), `kyn`/`ts` (the
 * frontmatter split and its `paths:`), `Sge` (comment blocks), `Ayn` (imports) and `FOn`'s
 * `trim()` — in [`docs/external/claude-code-memory-loader.md`](../../../../docs/external/claude-code-memory-loader.md).
 * The lexer is the one the binary bundles, `marked` 15.0.6, pinned exactly, with
 * `gfm: false` as the loader asks for it.
 *
 * ## One extractor, whatever the file is
 *
 * The harness runs this over a `.ts` import exactly as over a `.md` one, so VAT
 * does too: a blob routed to no document parser still gets these facts. That is
 * what makes the in-memory fixture and the on-disk lane answer identically —
 * both call {@link claudeMemoryFactsOf} and nothing else decides which `@`
 * tokens are imports, or which globs a file declares.
 *
 * ⛔ That second half is why `paths:` is read HERE and not off
 * `blobs.frontmatter`: that column is VAT's parser's answer, and a `.ts` import
 * routed to no parser has none — so its `paths:` went unread on disk, while the
 * in-memory fixture, parsing it as markdown, read them. The harness reads
 * `paths:` from its own split of ANY memory file.
 *
 * ## `ts`'s YAML parse
 *
 * The block `gB` captures goes through `Afr` — `Bun.YAML` in the shipped
 * binary; the excerpt does not show it — and a block that fails to parse
 * contributes no frontmatter while its body stays split off. `yaml` stands in
 * for it here, as it does in the loader reference, and a document that is not
 * a mapping declares no keys.
 *
 * ## What is deliberately NOT transcribed
 *
 * `Ayn` rejects a candidate for which `QT(M)` holds, and the excerpt does not
 * show `QT`. The loader reference (`test/helpers/claude-loader-reference.ts`)
 * omits it too, so the two agree; an import `QT` refuses would be charged here
 * and not by the harness.
 *
 * @vendor-claim reviewed=2026-09-23 verify=Re-extract `q7e`, `kyn`, `ts`, `Sge` and `Ayn` from the current Claude Code binary per docs/external/claude-code-memory-loader.md, confirm the bundled marked is still 15.0.6, and diff them against this module
 */

import { Lexer, type Token } from 'marked';
import { parseDocument } from 'yaml';

import { estimateTokens } from '../link-classify.js';

import { harnessPaths } from './claude-context-rules.js';

/** One `@` import, before anything resolves it against a path. */
interface ClaudeImport {
  /** The token as authored, `@` included. */
  readonly rawRef: string;
  /** The spelling the harness resolves: unescaped, fragment cut. */
  readonly target: string;
  /** 1-based line of the `@` — see `BlobClaudeImportRowSchema.line` for where it is approximate. */
  readonly line: number;
}

/** What the harness does with one blob's content. */
export interface ClaudeMemoryFacts {
  /** UTF-8 bytes of the injected text; 0 when the harness injects nothing. */
  readonly injectedBytes: number;
  /** The token estimate of the injected text. */
  readonly injectedTokens: number;
  /** Every import, first occurrence of each target, in document order. */
  readonly imports: readonly ClaudeImport[];
  /** `kyn`'s `paths:` globs, verbatim — null when the harness scopes the file by none. */
  readonly paths: readonly string[] | null;
}

/** One JS `\s` character. */
const WHITESPACE = /\s/;

/**
 * `gB` — `/^---\s*\n([\s\S]*?)---\s*\n?/`, the frontmatter block `ts` splits
 * off — as one linear scan. The regex backtracks quadratically over blank
 * lines after an unclosed opener; its first match is the WIDEST whitespace
 * run ending in a newline after `---`, then the first `---` after it, then
 * all trailing whitespace. The loader differential runs the regex verbatim
 * against this.
 *
 * @param text - BOM-stripped text
 * @returns The whole match and the captured block, or null when `gB` misses
 */
function matchFrontmatter(text: string): { whole: string; block: string } | null {
  if (!text.startsWith('---')) return null;
  let at = 3;
  let open = -1;
  while (at < text.length && WHITESPACE.test(text.charAt(at))) {
    if (text.charAt(at) === '\n') open = at;
    at += 1;
  }
  if (open === -1) return null;
  const close = text.indexOf('---', open + 1);
  if (close === -1) return null;
  let end = close + 3;
  while (end < text.length && WHITESPACE.test(text.charAt(end))) end += 1;
  return { whole: text.slice(0, end), block: text.slice(open + 1, close) };
}

/** The comment `Sge` and `Ayn` remove from a comment block. */
const COMMENT = /<!--[\s\S]*?-->/g;

/** `Ayn`'s scanner: the `@` opens the text or follows whitespace, and `\ ` is part of the path. */
const IMPORT_TOKEN = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

/** `U+FEFF` — the BOM `mE` strips before `gB` is tried. */
const BOM = 0xfe_ff;

/**
 * Everything the harness does with one blob's content.
 *
 * @param raw - The decoded text of the blob
 * @returns The injected measure and the imports
 */
export function claudeMemoryFactsOf(raw: string): ClaudeMemoryFacts {
  const { body, firstLine, block } = memoryBody(raw);
  const hasComment = body.includes('<!--');
  // `q7e` lexes only when there is a comment to strip or an `@` to read.
  const tokens = hasComment || body.includes('@') ? new Lexer({ gfm: false }).lex(body) : undefined;
  const injected = (hasComment && tokens !== undefined ? stripCommentBlocks(tokens) : body).trim();
  return {
    injectedBytes: Buffer.byteLength(injected, 'utf8'),
    injectedTokens: estimateTokens(injected),
    imports: tokens === undefined ? [] : extractImports(tokens, body, firstLine),
    paths: block === undefined ? null : harnessPaths(frontmatterOf(block)),
  };
}

/**
 * `kyn` → `ts`: the body after the first frontmatter match, BOM stripped when
 * one matched — the body follows the match even when its YAML fails to parse.
 *
 * @param raw - The decoded text
 * @returns The body, the 1-based line of the file it starts on, and the
 *   frontmatter block `gB` captured (undefined when there is none)
 */
function memoryBody(raw: string): { body: string; firstLine: number; block: string | undefined } {
  const unbommed = raw.codePointAt(0) === BOM ? raw.slice(1) : raw;
  const match = matchFrontmatter(unbommed);
  if (match === null) return { body: raw, firstLine: 1, block: undefined };
  return { body: unbommed.slice(match.whole.length), firstLine: 1 + newlinesIn(match.whole), block: match.block };
}

/**
 * `ts`'s frontmatter: the block's YAML as a mapping, or `{}` when it fails to
 * parse or is not a mapping.
 *
 * Only a block that can spell a `paths` key is parsed — the literal, or any
 * backslash escape a double-quoted key could spell it with. Every other block
 * declares no `paths:`, and parsing it would buy nothing.
 *
 * @param block - The text between the delimiters
 * @returns The mapping the harness reads `paths:` from
 */
function frontmatterOf(block: string): Readonly<Record<string, unknown>> {
  if (!block.includes('paths') && !block.includes('\\')) return {};
  const document = parseDocument(block);
  if (document.errors.length > 0) return {};
  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    // `toJS` refuses an alias bomb (`maxAliasCount`) with a ReferenceError: a
    // block that cannot be resolved declares nothing, as one that fails to parse does.
    if (error instanceof ReferenceError) return {};
    throw error;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * What a comment block leaves once its comments are gone — or undefined when
 * the token is not one. A comment block is an `html` token whose
 * `raw.trimStart()` opens `<!--` and closes `-->` (`Sge`'s and `Ayn`'s test).
 */
function commentResidue(token: Token): string | undefined {
  const opening = token.type === 'html' ? token.raw.trimStart() : '';
  return opening.startsWith('<!--') && opening.includes('-->') ? token.raw.replaceAll(COMMENT, '') : undefined;
}

/** `Sge` — the top-level token stream re-joined, each comment block replaced by its non-blank residue. */
function stripCommentBlocks(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      const residue = commentResidue(token);
      if (residue === undefined) return token.raw;
      return residue.trim().length > 0 ? residue : '';
    })
    .join('');
}

/** `Ayn`'s acceptance test on one reference, fragment already cut and `\ ` unescaped. */
function isImportShaped(ref: string): boolean {
  if (ref.startsWith('./') || ref.startsWith('~/')) return true;
  if (ref.startsWith('/') && ref !== '/') return true;
  return !ref.startsWith('@') && !/^[#%^&*()]+/.test(ref) && /^[a-zA-Z0-9._-]/.test(ref);
}

/** The target one scanner match names, or undefined when `Ayn` drops it. */
function targetOf(captured: string): string | undefined {
  const hash = captured.indexOf('#');
  const target = (hash === -1 ? captured : captured.slice(0, hash)).replaceAll(String.raw`\ `, ' ');
  return target.length > 0 && isImportShaped(target) ? target : undefined;
}

/**
 * Where a token sits in the body: its offset, and whether that offset is exact.
 * A token whose source text marked rewrote before lexing (a blockquote's inner
 * paragraph has no `> `) cannot be found in its parent, and inherits the
 * parent's offset, inexactly.
 */
interface Located {
  readonly offset: number;
  readonly exact: boolean;
}

/** One `Ayn` walk's state: the imports found so far, keyed by target, and the body's line index. */
interface ImportScan {
  readonly found: Map<string, ClaudeImport>;
  readonly lineOf: (offset: number) => number;
}

/**
 * `Ayn` — every import in document order, first occurrence of each target.
 *
 * `Ayn` collects into a `Set` of RESOLVED paths; collecting the spellings the
 * same way keeps the same first occurrences in the same order, and the reader
 * that resolves them drops a second spelling of one file as the harness does.
 */
function extractImports(tokens: readonly Token[], body: string, firstLine: number): ClaudeImport[] {
  const scan: ImportScan = { found: new Map(), lineOf: lineIndex(body, firstLine) };
  walkTokens(scan, tokens, body, { offset: 0, exact: true });
  return [...scan.found.values()];
}

/** `Ayn`'s `g` over one token list, each token located inside its parent's source text. */
function walkTokens(scan: ImportScan, tokens: readonly Token[], parentRaw: string, parent: Located): void {
  let cursor = 0;
  for (const token of tokens) {
    // Siblings' raws follow one another through the parent's, so the search
    // starts where the previous sibling ended.
    const at = parent.exact ? parentRaw.indexOf(token.raw, cursor) : -1;
    if (at >= 0) cursor = at + token.raw.length;
    visitToken(scan, token, at >= 0 ? { offset: parent.offset + at, exact: true } : { offset: parent.offset, exact: false });
  }
}

/** `Ayn`'s `g` on one token: skip code, read a comment block's residue, scan text, descend `tokens` and `items`. */
function visitToken(scan: ImportScan, token: Token, here: Located): void {
  if (token.type === 'code' || token.type === 'codespan') return;
  if (token.type === 'html') {
    const residue = commentResidue(token);
    if (residue !== undefined) scanText(scan, residue, { offset: here.offset, exact: false });
    return;
  }
  if (token.type === 'text') scanText(scan, textOf(token), { ...here, exact: here.exact && textOf(token) === token.raw });
  const nested = token as { tokens?: Token[]; items?: Token[] };
  if (nested.tokens !== undefined) walkTokens(scan, nested.tokens, token.raw, here);
  if (nested.items !== undefined) walkTokens(scan, nested.items, token.raw, here);
}

/** A text token's `text`, as `Ayn` reads it (`y.text || ""`). */
function textOf(token: Token): string {
  return (token as { text?: string }).text ?? '';
}

/** `Ayn`'s `s` over one run of text, recording each new target at its line. */
function scanText(scan: ImportScan, text: string, where: Located): void {
  if (text.trim().length === 0) return;
  for (const match of text.matchAll(IMPORT_TOKEN)) {
    const captured = match[1] ?? '';
    const target = targetOf(captured);
    if (target === undefined || scan.found.has(target)) continue;
    const atOffset = where.exact ? where.offset + match.index + match[0].indexOf('@') : where.offset;
    scan.found.set(target, { rawRef: `@${captured}`, target, line: scan.lineOf(atOffset) });
  }
}

/**
 * Offset → 1-based line of the FILE, for offsets into `body`.
 *
 * @param body - The frontmatter-stripped text
 * @param firstLine - The file line `body` starts on
 * @returns A lookup, binary-searching the body's newline offsets
 */
function lineIndex(body: string, firstLine: number): (offset: number) => number {
  let newlines: number[] | undefined;
  return (offset) => {
    newlines ??= [...body.matchAll(/\n/g)].map((match) => match.index);
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((newlines[middle] ?? Number.POSITIVE_INFINITY) < offset) low = middle + 1;
      else high = middle;
    }
    return firstLine + low;
  };
}

/** How many `\n` `text` holds. */
function newlinesIn(text: string): number {
  return text.split('\n').length - 1;
}
