/**
 * The skill-text core: the TEXT half of every skills-phase detector, as one
 * pure, linear function of a document's text and the declaration.
 *
 * {@link skillTextFactsOf} returns one record per thing a detector computes
 * from the text alone, in the order that detector emits it, so the live
 * constructors in agent-skills rebuild today's issues and evidence exactly.
 * What needs the frontmatter's values (a `description`, an `allowed-tools`
 * list), config, a location or another file is not here: it is judgement, and
 * it stays live.
 *
 * Every regex and constant comes from the declaration passed in
 * (`SKILL_TEXT_DECLARATION`); `local/skill-text-core-purity` refuses a regex,
 * a literal other than `0`, `1`, `-1` and `''`, and any runtime import here
 * but the declaration, the scanner and the fence rule (`frontmatterFencesOf`),
 * which the rule holds to the same terms. So the declaration's digest covers
 * everything the output depends on except the control flow of these modules.
 *
 * Linear: each scanned string gets one line index; a record's line is a binary
 * search in it, never a rescan of the text before it. Each declared regex is
 * linear on its own, and the one that was not, the `mcp__` form, is replaced
 * by {@link scanClaudeCodeQualified}, whose step count its test bounds.
 */

import type { FrontmatterFence, SkillTextFacts, SkillTextMatch } from '../schemas/skill-text-facts.js';

import { type PatternId, SKILL_TEXT_DECLARATION, type SkillTextDeclaration, type SkillTextFamily } from './declaration.js';
import { frontmatterFencesOf } from './frontmatter-fences.js';
import { scanClaudeCodeQualified } from './qualified-scanner.js';

/**
 * The core's own copy of each declaration it is given, made the first time it
 * sees that declaration and never handed out. `SKILL_TEXT_DECLARATION`'s copy
 * is made here, at module load, before any code outside this package can hold
 * the public object.
 *
 * The public declaration's regexes are shared and unfrozen (a frozen regex runs
 * on V8's slow path), so any holder can move a global regex's `lastIndex`,
 * which `matchAll` copies into the scan, or `compile()` a pattern in place.
 * The core reads only its copy, so neither reaches its answer.
 * `structuredClone` copies each regex's source and flags into a fresh,
 * unfrozen regex with `lastIndex` 0, so the copy keeps the fast path and the
 * declaration's digest (source and flags only) describes it exactly. A
 * declaration is applied as it was at first sight: a later change to the
 * object passed in is not seen.
 */
const ownedCopies = new WeakMap<SkillTextDeclaration, SkillTextDeclaration>([
  [SKILL_TEXT_DECLARATION, structuredClone(SKILL_TEXT_DECLARATION)],
]);

/** The core's own copy of `declaration`: see {@link ownedCopies}. */
function ownedCopyOf(declaration: SkillTextDeclaration): SkillTextDeclaration {
  let owned = ownedCopies.get(declaration);
  if (owned === undefined) {
    owned = structuredClone(declaration);
    ownedCopies.set(declaration, owned);
  }
  return owned;
}

type Emit = (family: SkillTextFamily, patternId: PatternId, line: number, matchText: string) => void;

/** A string's lines and the offset each starts at. */
interface LineIndex {
  lines: string[];
  starts: number[];
}

function indexLines(text: string, separator: string): LineIndex {
  const lines = text.split(separator);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + separator.length;
  }
  return { lines, starts };
}

/** The 1-based line `offset` falls on: a binary search, never a rescan. */
function lineAt(index: LineIndex, offset: number): number {
  let low = 0;
  let high = index.starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if ((index.starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Per line, the first pattern that matches (time-sensitive, asset and command families). */
function firstPerLine(
  lines: readonly string[],
  family: SkillTextFamily,
  patterns: ReadonlyArray<{ readonly id: PatternId; readonly pattern: RegExp }>,
  emit: Emit,
): void {
  for (const [index, line] of lines.entries()) {
    for (const { id, pattern } of patterns) {
      const match = pattern.exec(line);
      if (match !== null) {
        emit(family, id, index + 1, match[0]);
        break;
      }
    }
  }
}

/** `tool` without the separators a capture can end on, walked backwards (nothing to backtrack). */
function withoutTrailingSeparators(tool: string, separators: ReadonlySet<string>): string {
  let end = tool.length;
  while (end > 0 && separators.has(tool.charAt(end - 1))) end--;
  return tool.slice(0, end);
}

/** A tool half opens lowercase and carries an underscore, a hyphen or a camelCase hump. */
function isMultiSegmentToolName(tool: string, mcp: SkillTextDeclaration['mcp']): boolean {
  if (!mcp.toolStartsLowercase.test(tool)) return false;
  return tool.includes(mcp.underscore) || tool.includes(mcp.hyphen) || mcp.toolHasCaseHump.test(tool);
}

/** Every MCP tool name `text` spells fully-qualified, in either spelling. */
function qualifiedNamesIn(text: string, declaration: SkillTextDeclaration): Set<string> {
  const { mcp } = declaration;
  const separators = new Set<string>(mcp.toolSeparators);
  const vocabulary = new Set<string>();
  for (const capture of scanClaudeCodeQualified(text, declaration).captures) {
    const tool = withoutTrailingSeparators(capture, separators);
    if (tool !== '' && isMultiSegmentToolName(tool, mcp)) vocabulary.add(tool);
  }
  for (const match of text.matchAll(mcp.apiQualified)) {
    const [, server, tool] = match;
    if (server === undefined || tool === undefined) continue;
    if (!mcp.serverIsNamed.test(server) || !isMultiSegmentToolName(tool, mcp)) continue;
    vocabulary.add(tool);
  }
  return vocabulary;
}

/** One past the closing frontmatter fence, or 0: the MCP detector's own fence rule (trimmed lines). */
function frontmatterEnd(lines: readonly string[], fence: string): number {
  if (lines[0]?.trim() !== fence) return 0;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === fence) return index + 1;
  }
  return 0;
}

/** MCP_TOOL_NAME_UNQUALIFIED: frontmatter blanked, vocabulary from the prose, one record per (line, bare name). */
function mcpRecords(lines: readonly string[], declaration: SkillTextDeclaration, emit: Emit): void {
  const { mcp } = declaration;
  const scannable = [...lines];
  const end = frontmatterEnd(scannable, mcp.frontmatterFence);
  for (let index = 0; index < end; index++) scannable[index] = '';
  const vocabulary = qualifiedNamesIn(scannable.join(declaration.lineSeparator), declaration);
  if (vocabulary.size === 0) return;

  for (const [index, line] of scannable.entries()) {
    const seenOnLine = new Set<string>();
    // Once per line at most, and only after a span hit the vocabulary.
    let qualifiedOnLine: Set<string> | undefined;
    for (const match of line.matchAll(mcp.codeSpan)) {
      const inner = (match[1] ?? '').trim();
      if (!vocabulary.has(inner) || seenOnLine.has(inner)) continue;
      qualifiedOnLine ??= qualifiedNamesIn(line, declaration);
      if (qualifiedOnLine.has(inner)) continue;
      seenOnLine.add(inner);
      emit(mcp.family, mcp.patternId, index + 1, inner);
    }
  }
}

/** Whether a dependency intro sits in the declared window before `offset`. */
function hasDependencyIntro(text: string, offset: number, crossSkill: SkillTextDeclaration['crossSkill']): boolean {
  return crossSkill.dependencyIntro.test(text.slice(Math.max(0, offset - crossSkill.lookbehindChars), offset));
}

/** SKILL_CROSS_SKILL_AUTH_UNDECLARED over `text`: distinct introduced sibling refs, then env keys, each at its first introduced line. */
function crossSkillRecords(
  text: string,
  index: LineIndex,
  family: SkillTextFamily,
  declaration: SkillTextDeclaration,
  emit: Emit,
): void {
  const { crossSkill } = declaration;
  const siblings = new Map<string, number>();
  for (const match of text.matchAll(crossSkill.siblingRef.pattern)) {
    const ref = match[0].slice(1, -1);
    if (!siblings.has(ref) && hasDependencyIntro(text, match.index, crossSkill)) siblings.set(ref, lineAt(index, match.index));
  }
  const envKeys = new Map<string, number>();
  for (const match of text.matchAll(crossSkill.envKey.pattern)) {
    const envKey = match[0];
    if (envKey === crossSkill.envKeySkip || envKeys.has(envKey)) continue;
    if (hasDependencyIntro(text, match.index, crossSkill)) envKeys.set(envKey, lineAt(index, match.index));
  }
  for (const [ref, line] of siblings) emit(family, crossSkill.siblingRef.id, line, ref);
  for (const [envKey, line] of envKeys) emit(family, crossSkill.envKey.id, line, envKey);
}

/**
 * Where the frontmatter fences are (the record's `frontmatterFence`), and the
 * body the frontmatter parser returns on success, or `undefined` when the
 * fences it requires are absent. Whether the block between them decodes is
 * judgement the caller has already made: on a failed parse it reads no body
 * record.
 */
function parserBody(text: string, declaration: SkillTextDeclaration): { fence: FrontmatterFence; body: string | undefined } {
  const { fenceStates } = declaration.body;
  const { lines, opened, closing } = frontmatterFencesOf(text, declaration);
  if (!opened) return { fence: fenceStates.none, body: undefined };
  if (closing === -1) return { fence: fenceStates.unclosed, body: undefined };
  return { fence: fenceStates.closed, body: lines.slice(closing + 1).join(declaration.lineSeparator) };
}

/** SKILL_BODY_NOT_IMPERATIVE: second-person openers outside fences and quotes, with the line's leading sample. */
function imperativeRecords(lines: readonly string[], declaration: SkillTextDeclaration, emit: Emit): void {
  const { imperative } = declaration;
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (imperative.fence.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || imperative.quote.test(line)) continue;
    if (imperative.opener.test(line)) emit(imperative.family, imperative.id, index + 1, line.slice(0, imperative.sampleChars));
  }
}

/** The `allowed-tools:` key's line in the frontmatter span: the opening fence is line 1. */
function allowedToolsKeyRecord(text: string, declaration: SkillTextDeclaration, emit: Emit): void {
  const { compat, lineSeparator } = declaration;
  const frontmatter = compat.frontmatter.exec(text.replaceAll(compat.crlf, lineSeparator))?.[1];
  if (frontmatter === undefined) return;
  const key = compat.allowedToolsKey.pattern.exec(frontmatter);
  if (key === null) return;
  const line = 1 + frontmatter.slice(0, key.index).split(lineSeparator).length;
  emit(compat.allowedToolsKey.family, compat.allowedToolsKey.id, line, key[0]);
}

interface CodeBlock {
  language: string;
  body: string;
  /** The opening fence's line. */
  line: number;
  /** The body's offset in the text. */
  bodyIndex: number;
}

function codeBlocks(text: string, index: LineIndex, declaration: SkillTextDeclaration): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const match of text.matchAll(declaration.compat.codeBlock)) {
    const [whole, language = '', body = ''] = match;
    blocks.push({
      language,
      body,
      line: lineAt(index, match.index),
      bodyIndex: match.index + whole.indexOf(declaration.lineSeparator) + 1,
    });
  }
  return blocks;
}

/** The compat capability evidence's text half, in the detector's order. */
function compatRecords(text: string, index: LineIndex, declaration: SkillTextDeclaration, emit: Emit): void {
  const { compat } = declaration;
  allowedToolsKeyRecord(text, declaration, emit);

  const prose = compat.proseTool.pattern.exec(text);
  if (prose !== null) emit(compat.proseTool.family, compat.proseTool.id, lineAt(index, prose.index), prose[0]);

  const shellLanguages = new Set<string>(compat.shellLanguages);
  const blocks = codeBlocks(text, index, declaration);
  const firstShell = blocks.find((block) => shellLanguages.has(block.language.toLowerCase()));
  if (firstShell !== undefined) emit(compat.fencedShell.family, compat.fencedShell.id, firstShell.line, firstShell.language);

  for (const block of blocks) {
    const language = block.language.toLowerCase();
    if (!shellLanguages.has(language) && language !== '') continue;
    for (const { patternId, pattern } of compat.externalCli) {
      const match = pattern.exec(block.body);
      if (match !== null) emit(compat.externalCliFamily, patternId, lineAt(index, block.bodyIndex + match.index), match[0]);
    }
  }

  for (const { id, pattern } of compat.browserAuth) {
    const match = pattern.exec(text);
    if (match !== null) emit(compat.browserAuthFamily, id, lineAt(index, match.index), match[0]);
  }
}

/**
 * The skill-text facts of `text`: see the module note.
 *
 * @param text - The document's decoded text, frontmatter and all
 * @param given - `SKILL_TEXT_DECLARATION`; the core reads its own copy (see {@link ownedCopies})
 */
export function skillTextFactsOf(text: string, given: SkillTextDeclaration): SkillTextFacts {
  const declaration = ownedCopyOf(given);
  const matches: SkillTextMatch[] = [];
  const emit: Emit = (family, patternId, line, matchText) => {
    matches.push({ ordinal: matches.length, family, patternId, line, matchText });
  };

  const index = indexLines(text, declaration.lineSeparator);
  firstPerLine(index.lines, declaration.timeSensitive.family, declaration.timeSensitive.patterns, emit);
  firstPerLine(index.lines, declaration.nonPortableAsset.family, declaration.nonPortableAsset.patterns, emit);
  firstPerLine(index.lines, declaration.nonPortableCommand.family, declaration.nonPortableCommand.patterns, emit);
  mcpRecords(index.lines, declaration, emit);
  crossSkillRecords(text, index, declaration.crossSkill.family, declaration, emit);

  const { fence, body } = parserBody(text, declaration);
  if (body !== undefined) {
    const bodyIndex = indexLines(body, declaration.lineSeparator);
    crossSkillRecords(body, bodyIndex, declaration.crossSkill.bodyFamily, declaration, emit);
    imperativeRecords(bodyIndex.lines, declaration, emit);
  }

  compatRecords(text, index, declaration, emit);

  return {
    lineCount: index.lines.length,
    h1: declaration.h1.exec(text)?.[1] ?? null,
    frontmatterFence: fence,
    matches,
  };
}
