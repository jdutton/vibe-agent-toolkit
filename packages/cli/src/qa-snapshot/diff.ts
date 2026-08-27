/**
 * Comparing two loaded snapshots — the cheap half of the QA instrument.
 *
 * Everything here is pure: no `fs`, no `process`, no clock. A comparison is a
 * function of two `LoadedSnapshot` values, which is what makes it testable at
 * the unit tier and what makes its refusals reproducible.
 *
 * ## Three deliberate cheapnesses, each with a stated blind spot
 *
 * 1. `countLineDelta` is a multiset difference, not an LCS. It is O(n) and
 *    therefore affordable for every artifact on every comparison — one captured
 *    artifact is 1.81 MB — but it is **order-insensitive**, so a pure
 *    reordering counts `0/0`. Status is therefore decided by string equality
 *    and never by the counts.
 * 2. `extractHeaderFacts` scans leading `key: value` lines rather than parsing.
 *    A 1.8 MB YAML parse is slow and a JSON parse of a truncated capture throws,
 *    so the headline column is **advisory** — see its JSDoc.
 * 3. `renderUnifiedDiff` runs a real LCS only within a bounded cell budget and
 *    otherwise degrades to a positional report, which is a different and weaker
 *    statement. It says so in its own output rather than looking complete.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

import type {
  ArtifactDelta,
  ArtifactKind,
  ArtifactStatus,
  CompareReport,
  LoadedSnapshot,
  SnapshotManifest,
} from './types.js';

/** Leading `key: value` line of an oracle artifact header. */
const ORACLE_HEADER_LINE = /^([A-Za-z][A-Za-z0-9]*): (.*)$/u;

/**
 * Top-level scalar line of a YAML or JSON capture, key optionally quoted.
 *
 * Every quantifier here is over a character class disjoint from what follows
 * it, and every one except the final `(.*)$` is explicitly BOUNDED. That is
 * deliberate: this pattern is run over `vat audit` output reaching ~1.8 MB,
 * where a super-linearly backtracking alternative would not be a theoretical
 * risk. Indentation is matched as literal spaces rather than `\s`, because a
 * tab would not be YAML indentation anyway.
 *
 * The bounds are semantic, not lint appeasement. This scan only ever wants
 * *top-level* scalars — indent 0 for YAML, at most 2 for JSON — so a line
 * indented past `{0,8}` is one the caller would reject on the next line
 * anyway ({@link readTopLevelScalar} compares against `maxIndent`). Bounding
 * the separator runs is safe for the same reason: {@link cleanScalarValue}
 * trims the captured value, so spaces past the bound land in the capture and
 * are removed rather than changing the result.
 */
const COMMAND_HEADER_LINE = /^( {0,8})"?([A-Za-z_][A-Za-z0-9_-]*)"? {0,4}: {0,4}(.*)$/u;

/** Values that mean "a container follows", not a scalar. */
const CONTAINER_VALUE_PREFIXES = new Set(['{', '[', '|', '>']);

/** How many lines of a command capture the header scan is willing to read. */
const COMMAND_SCAN_LINE_LIMIT = 2000;

/** How many header keys a command capture may contribute. */
const COMMAND_HEADER_KEY_LIMIT = 60;

/** Above this line count on either side, `renderUnifiedDiff` refuses to run an LCS. */
const LCS_MAX_LINES = 20_000;

/**
 * Cell budget for the LCS table, after common prefix/suffix trimming.
 *
 * A `Uint32Array` of this size is ~16 MB, which is affordable; the untrimmed
 * worst case at {@link LCS_MAX_LINES} would be 400 M cells, which is not.
 */
const LCS_MAX_CELLS = 4_000_000;

/** One line of a computed diff, before line numbers are assigned. */
interface RawOp {
  kind: ' ' | '-' | '+';
  text: string;
}

/** One line of a computed diff, with its 1-based line number on each side. */
interface DiffOp extends RawOp {
  /** 1-based line in `before`, or 0 for an addition. */
  aLine: number;
  /** 1-based line in `after`, or 0 for a removal. */
  bLine: number;
}

/** A pair of artifacts to compare, either side possibly absent. */
interface ArtifactPair {
  name: string;
  kind: ArtifactKind;
  beforeArtifact: string | null;
  afterArtifact: string | null;
}

/**
 * Line-level delta counts between two texts, order-insensitive.
 *
 * Computed as a multiset difference over lines: O(n) in the combined line
 * count, which is what makes it affordable for every artifact on every
 * comparison. The cost of that cheapness is real, and is the reason
 * `ArtifactStatus` is decided by string equality instead: **a pure reordering
 * of identical lines returns `{ addedLines: 0, removedLines: 0 }` even though
 * the two texts differ.** Never infer "unchanged" from these counts.
 *
 * @param before - Text from the earlier snapshot
 * @param after - Text from the later snapshot
 * @returns Counts of lines present only in `after` and only in `before`
 */
export function countLineDelta(
  before: string,
  after: string,
): { addedLines: number; removedLines: number } {
  const remaining = new Map<string, number>();
  for (const line of before.split('\n')) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }

  let addedLines = 0;
  for (const line of after.split('\n')) {
    const available = remaining.get(line) ?? 0;
    if (available > 0) {
      remaining.set(line, available - 1);
    } else {
      addedLines += 1;
    }
  }

  let removedLines = 0;
  for (const count of remaining.values()) {
    removedLines += count;
  }

  return { addedLines, removedLines };
}

/**
 * Leading `key: value` header facts, for the advisory headline column.
 *
 * ⚠️ **Advisory, and deliberately not a parse.** For `oracle` text the header is
 * the run of leading `key: value` lines before the first blank line — exactly
 * what `pipeline-oracles/serialize.ts` emits (`lane:`, `corpus:`,
 * `enumeratedCount:`, `blobCount:`, `keyDisagreementCount:`, …). For `command`
 * text it is a shallow scan of top-level scalar lines (indent 0 for YAML,
 * indent no greater than 2 for JSON), capped at the first
 * {@link COMMAND_HEADER_KEY_LIMIT} keys and {@link COMMAND_SCAN_LINE_LIMIT} lines.
 *
 * Parsing the document instead was rejected at both ends: a 1.8 MB YAML parse is
 * slow enough to dominate the comparison, and a JSON parse of a capture that was
 * truncated by a crashing child throws rather than degrading. So the
 * authoritative signal is `status` plus the line counts; headlines exist to save
 * a drill-down, never to replace one.
 *
 * @param text - Artifact text, LF-normalized
 * @param kind - Which scan to apply
 * @returns Header key to value, in the order encountered
 */
export function extractHeaderFacts(text: string, kind: ArtifactKind): Map<string, string> {
  return kind === 'oracle' ? extractOracleHeader(text) : extractCommandHeader(text);
}

/**
 * Leading header of an oracle artifact: `key: value` lines before the first blank.
 *
 * @param text - Artifact text
 * @returns Header key to value
 */
function extractOracleHeader(text: string): Map<string, string> {
  const facts = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      break;
    }
    const match = ORACLE_HEADER_LINE.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined) {
      facts.set(key, value);
    }
  }
  return facts;
}

/**
 * Shallow scan of top-level scalars in a YAML or JSON command capture.
 *
 * @param text - Artifact text
 * @returns Header key to value, capped
 */
function extractCommandHeader(text: string): Map<string, string> {
  const facts = new Map<string, string>();
  const lines = text.split('\n');
  const maxIndent = looksLikeJson(lines) ? 2 : 0;
  const scanLimit = Math.min(lines.length, COMMAND_SCAN_LINE_LIMIT);

  for (let index = 0; index < scanLimit; index += 1) {
    if (facts.size >= COMMAND_HEADER_KEY_LIMIT) {
      break;
    }
    const entry = readTopLevelScalar(lines[index] ?? '', maxIndent);
    if (entry !== null) {
      facts.set(entry.key, entry.value);
    }
  }
  return facts;
}

/**
 * Whether a capture opens with a JSON container rather than YAML.
 *
 * @param lines - Capture lines
 * @returns `true` when the first non-blank line starts a JSON object or array
 */
function looksLikeJson(lines: readonly string[]): boolean {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      return trimmed.startsWith('{') || trimmed.startsWith('[');
    }
  }
  return false;
}

/**
 * Read one `key: value` scalar line, if it is shallow enough to be top-level.
 *
 * @param line - The raw line
 * @param maxIndent - Greatest leading-space count still considered top level
 * @returns The key and its cleaned value, or `null` when the line is not a top-level scalar
 */
function readTopLevelScalar(
  line: string,
  maxIndent: number,
): { key: string; value: string } | null {
  const match = COMMAND_HEADER_LINE.exec(line);
  const indent = match?.[1];
  const key = match?.[2];
  const rawValue = match?.[3];
  if (indent === undefined || key === undefined || rawValue === undefined) {
    return null;
  }
  if (indent.length > maxIndent) {
    return null;
  }

  const value = cleanScalarValue(rawValue);
  if (value === '' || CONTAINER_VALUE_PREFIXES.has(value)) {
    return null;
  }
  return { key, value };
}

/**
 * Strip a JSON trailing comma and surrounding double quotes from a scalar.
 *
 * @param rawValue - Value text as it appeared after the colon
 * @returns The cleaned value
 */
function cleanScalarValue(rawValue: string): string {
  let value = rawValue.trim();
  if (value.endsWith(',')) {
    value = value.slice(0, -1).trim();
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * `enumeratedCount 265→267` strings for header keys whose values differ.
 *
 * Only keys present on both sides are reported: a key that appeared or vanished
 * is a shape change, which the line counts already make visible, and reporting
 * it here would read as a value move. Inherits every caveat of
 * {@link extractHeaderFacts} — this column is advisory.
 *
 * @param before - Artifact text from the earlier snapshot
 * @param after - Artifact text from the later snapshot
 * @param kind - Which header scan to apply
 * @returns One `name before→after` string per moved key, in header order
 */
export function headlineChanges(before: string, after: string, kind: ArtifactKind): string[] {
  const beforeFacts = extractHeaderFacts(before, kind);
  const afterFacts = extractHeaderFacts(after, kind);

  const changes: string[] = [];
  for (const [key, beforeValue] of beforeFacts) {
    const afterValue = afterFacts.get(key);
    if (afterValue !== undefined && afterValue !== beforeValue) {
      changes.push(`${key} ${beforeValue}→${afterValue}`);
    }
  }
  return changes;
}

/**
 * Compare two loaded snapshots. Pure — no fs, no process, no clock.
 *
 * **Nothing is refused here on layout grounds, and that is not a loosening.**
 * A manifest whose layout this build cannot read never gets this far — `store.ts`
 * refuses it at load against `SnapshotManifestSchema`, which is strictly more
 * discriminating than the `formatVersion` integer that used to be compared here
 * and needs nobody to remember to move it. An artifact captured on one side only
 * is not a layout difference: `pairArtifacts` pairs what each manifest names and
 * `presenceConstraints` says which side it was missing from.
 *
 * Everything this comparison cannot do — a different corpus, a cross-platform
 * walk-route comparison, a half captured on one side only — is stated in
 * `constraints`, and the comparison continues.
 *
 * `capturedAtIso` and each command's `wallMs` are never compared as content.
 *
 * @param before - The earlier snapshot
 * @param after - The later snapshot
 * @returns A report whose `deltas` is empty when the comparison was refused
 */
export function compareSnapshots(before: LoadedSnapshot, after: LoadedSnapshot): CompareReport {
  const provenanceNotes = collectProvenanceNotes(before.manifest, after.manifest);

  const constraints: string[] = [];
  constraints.push(
    ...corpusConstraints(before.manifest, after.manifest),
    ...platformConstraints(before.manifest, after.manifest),
  );

  const pairs = pairArtifacts(before.manifest, after.manifest);
  const deltas = pairs.map((pair) => toDelta(pair, before, after));
  constraints.push(...presenceConstraints(deltas));

  return {
    beforeDir: before.dir,
    afterDir: after.dir,
    deltas,
    changedCount: deltas.filter((delta) => delta.status !== 'same').length,
    constraints,
    provenanceNotes,
  };
}

/**
 * Provenance differences worth stating but never blocking.
 *
 * The version and platform notes are emitted unconditionally so a renderer
 * always has a provenance line to print; `captured` is stated because it is the
 * one field that always differs and is never compared as content.
 *
 * @param before - Earlier manifest
 * @param after - Later manifest
 * @returns Notes in a stable order
 */
function collectProvenanceNotes(before: SnapshotManifest, after: SnapshotManifest): string[] {
  return [
    `vat ${before.vatVersion} → ${after.vatVersion}`,
    `node ${before.nodeVersion} → ${after.nodeVersion}`,
    `platform ${before.platform} → ${after.platform}`,
    `captured ${before.capturedAtIso} → ${after.capturedAtIso}`,
  ];
}

/**
 * Constraints about whether the two captures even describe the same corpus.
 *
 * @param before - Earlier manifest
 * @param after - Later manifest
 * @returns Zero, one or two constraint strings
 */
function corpusConstraints(before: SnapshotManifest, after: SnapshotManifest): string[] {
  const constraints: string[] = [];
  const beforeName = lastPathSegment(before.corpusRoot);
  const afterName = lastPathSegment(after.corpusRoot);
  if (beforeName !== afterName) {
    constraints.push(
      `CORPUS: corpusRoot basename differs (${beforeName} → ${afterName}). These two snapshots may not be ` +
        'comparable at all — every difference below may be a difference of corpus rather than of pipeline.',
    );
  }
  if (before.corpusGitHead !== after.corpusGitHead) {
    constraints.push(
      `CORPUS: corpusGitHead differs (${before.corpusGitHead ?? '-'} → ${after.corpusGitHead ?? '-'}). Content ` +
        'differences below may be corpus changes rather than pipeline changes.',
    );
  }
  return constraints;
}

/**
 * Constraint about comparing walk-route ordering across two different hosts.
 *
 * @param before - Earlier manifest
 * @param after - Later manifest
 * @returns Zero or one constraint string
 */
function platformConstraints(before: SnapshotManifest, after: SnapshotManifest): string[] {
  if (before.platform === after.platform) {
    return [];
  }
  const affected = new Set<string>();
  for (const lane of [...before.lanes, ...after.lanes]) {
    if (!lane.orderPortable) {
      affected.add(lane.laneId);
    }
  }
  if (affected.size === 0) {
    return [];
  }
  return [
    `PLATFORM: platform differs (${before.platform} → ${after.platform}) and these lanes were answered by the ` +
      'filesystem walk route, whose ordering is filesystem order and is NOT comparable across hosts: ' +
      `${[...affected].sort((a, b) => a.localeCompare(b)).join(', ')}.`,
  ];
}

/**
 * Constraints naming each artifact present on only one side.
 *
 * @param deltas - Computed deltas
 * @returns One constraint per added or removed artifact
 */
function presenceConstraints(deltas: readonly ArtifactDelta[]): string[] {
  const constraints: string[] = [];
  for (const delta of deltas) {
    if (delta.status === 'added') {
      constraints.push(
        `ADDED: '${delta.name}' exists in the AFTER snapshot only. There is nothing to compare it against.`,
      );
    } else if (delta.status === 'removed') {
      constraints.push(
        `REMOVED: '${delta.name}' exists in the BEFORE snapshot only. Its absence is not evidence of a passing run.`,
      );
    }
  }
  return constraints;
}

/**
 * Last segment of a path, tolerant of either separator and of a trailing slash.
 *
 * @param value - A path as recorded in the manifest
 * @returns The final segment, or the original value when there is none
 */
function lastPathSegment(value: string): string {
  const segments = toForwardSlash(value)
    .split('/')
    .filter((segment) => segment !== '');
  return segments.at(-1) ?? value;
}

/**
 * Enumerate every artifact selector across both snapshots, in display order.
 *
 * Selector names are the strings a user passes to `--detail`, so they are
 * stable: `enumeration.<laneId>`, `parse-facts`, `command.<name>.stdout`,
 * `command.<name>.stderr`.
 *
 * @param before - Earlier manifest
 * @param after - Later manifest
 * @returns One pair per selector
 */
function pairArtifacts(before: SnapshotManifest, after: SnapshotManifest): ArtifactPair[] {
  const pairs: ArtifactPair[] = [];

  const beforeLanes = new Map<string, string>(
    before.lanes.map((lane) => [lane.laneId, lane.artifact]),
  );
  const afterLanes = new Map<string, string>(
    after.lanes.map((lane) => [lane.laneId, lane.artifact]),
  );
  for (const laneId of orderedKeys(beforeLanes, afterLanes)) {
    pairs.push({
      name: `enumeration.${laneId}`,
      kind: 'oracle',
      beforeArtifact: beforeLanes.get(laneId) ?? null,
      afterArtifact: afterLanes.get(laneId) ?? null,
    });
  }

  if (before.parseFactArtifact !== null || after.parseFactArtifact !== null) {
    pairs.push({
      name: 'parse-facts',
      kind: 'oracle',
      beforeArtifact: before.parseFactArtifact,
      afterArtifact: after.parseFactArtifact,
    });
  }

  pairs.push(...pairCommandArtifacts(before, after));
  return pairs;
}

/**
 * Pair the two streams of every command present on either side.
 *
 * @param before - Earlier manifest
 * @param after - Later manifest
 * @returns Two pairs per command
 */
function pairCommandArtifacts(before: SnapshotManifest, after: SnapshotManifest): ArtifactPair[] {
  const beforeCommands = new Map(before.commands.map((command) => [command.name, command]));
  const afterCommands = new Map(after.commands.map((command) => [command.name, command]));

  const pairs: ArtifactPair[] = [];
  for (const name of orderedKeys(beforeCommands, afterCommands)) {
    const beforeCommand = beforeCommands.get(name);
    const afterCommand = afterCommands.get(name);
    pairs.push(
      {
        name: `command.${name}.stdout`,
        kind: 'command',
        beforeArtifact: beforeCommand?.stdoutArtifact ?? null,
        afterArtifact: afterCommand?.stdoutArtifact ?? null,
      },
      {
        name: `command.${name}.stderr`,
        kind: 'command',
        beforeArtifact: beforeCommand?.stderrArtifact ?? null,
        afterArtifact: afterCommand?.stderrArtifact ?? null,
      },
    );
  }
  return pairs;
}

/**
 * Keys of the first map in its own order, followed by keys only in the second.
 *
 * @param first - Earlier-side map
 * @param second - Later-side map
 * @returns The union, ordered so the before side drives display order
 */
function orderedKeys<T>(first: ReadonlyMap<string, T>, second: ReadonlyMap<string, T>): string[] {
  const keys = [...first.keys()];
  for (const key of second.keys()) {
    if (!first.has(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Turn one artifact pair into its delta row.
 *
 * `status` is decided by string equality, never by the line counts — see
 * {@link countLineDelta} for why that distinction is load-bearing.
 *
 * @param pair - The selector and its artifact path on each side
 * @param before - Earlier snapshot
 * @param after - Later snapshot
 * @returns The delta row
 */
function toDelta(
  pair: ArtifactPair,
  before: LoadedSnapshot,
  after: LoadedSnapshot,
): ArtifactDelta {
  const beforeText = readArtifact(before, pair.beforeArtifact);
  const afterText = readArtifact(after, pair.afterArtifact);
  const artifact = pair.afterArtifact ?? pair.beforeArtifact ?? pair.name;

  if (beforeText === null || afterText === null) {
    return onePresentDelta(pair, artifact, beforeText, afterText);
  }

  const status: ArtifactStatus = beforeText === afterText ? 'same' : 'changed';
  const { addedLines, removedLines } = countLineDelta(beforeText, afterText);
  return {
    name: pair.name,
    kind: pair.kind,
    artifact,
    status,
    addedLines,
    removedLines,
    headlines: status === 'same' ? [] : headlineChanges(beforeText, afterText, pair.kind),
  };
}

/**
 * Delta row for an artifact that exists on exactly one side.
 *
 * @param pair - The selector and its artifact path on each side
 * @param artifact - Artifact path to record
 * @param beforeText - Earlier text, or `null` when absent
 * @param afterText - Later text, or `null` when absent
 * @returns An `added` or `removed` row whose counts are the whole file
 */
function onePresentDelta(
  pair: ArtifactPair,
  artifact: string,
  beforeText: string | null,
  afterText: string | null,
): ArtifactDelta {
  const added = afterText !== null;
  const text = (added ? afterText : beforeText) ?? '';
  const lineCount = text === '' ? 0 : text.split('\n').length;
  return {
    name: pair.name,
    kind: pair.kind,
    artifact,
    status: added ? 'added' : 'removed',
    addedLines: added ? lineCount : 0,
    removedLines: added ? 0 : lineCount,
    headlines: [],
  };
}

/**
 * Fetch one artifact's text.
 *
 * A path named by the manifest but missing from the loaded map is treated as
 * absent rather than as empty: "the capture did not produce this" and "the
 * capture produced nothing" are different claims.
 *
 * @param snapshot - The snapshot to read from
 * @param artifact - Relative artifact path, or `null` when this side has none
 * @returns The text, or `null` when this side has no such artifact
 */
function readArtifact(
  snapshot: LoadedSnapshot,
  artifact: string | null,
): string | null {
  if (artifact === null) {
    return null;
  }
  const text = snapshot.artifacts.get(artifact);
  if (text === undefined) {
    return null;
  }
  return text;
}

/**
 * Unified diff for ONE artifact, bounded.
 *
 * Runs a real LCS only when both sides are under {@link LCS_MAX_LINES} and the
 * trimmed middle fits the {@link LCS_MAX_CELLS} budget. Otherwise it degrades to
 * a positional report — a weaker statement, since one inserted line makes every
 * later line look changed — and says so in the returned text rather than
 * returning a half-diff that reads as complete. `truncated` is `true` whenever
 * the returned text is not the whole story, for either reason.
 *
 * @param before - Artifact text from the earlier snapshot
 * @param after - Artifact text from the later snapshot
 * @param options - `maxLines` caps the returned text; `context` is unchanged lines kept around each hunk
 * @returns The diff text, whether it was cut short, and the hunk count before capping
 */
export function renderUnifiedDiff(
  before: string,
  after: string,
  options: { maxLines: number; context: number },
): { text: string; truncated: boolean; totalHunks: number } {
  if (before === after) {
    return { text: 'identical\n', truncated: false, totalHunks: 0 };
  }

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const overLineBudget =
    beforeLines.length > LCS_MAX_LINES || afterLines.length > LCS_MAX_LINES;
  const ops = overLineBudget ? null : computeOps(beforeLines, afterLines);

  if (ops === null) {
    // The two bail-outs are different facts and must not share one sentence: a
    // reader who is told "too many lines" about a 3,000-line artifact will go
    // looking for a file that does not exist.
    const reason = overLineBudget
      ? `${String(beforeLines.length)} before / ${String(afterLines.length)} after lines exceed the ` +
        `${String(LCS_MAX_LINES)}-line LCS budget`
      : `too much of the text differs: aligning it would need more than ${String(LCS_MAX_CELLS)} LCS table ` +
        `cells (${String(beforeLines.length)} before / ${String(afterLines.length)} after lines, almost none shared)`;
    return renderPositionalReport(beforeLines, afterLines, options.maxLines, reason);
  }

  const hunks = buildHunks(ops, options.context);
  const lines: string[] = [];
  for (const hunk of hunks) {
    lines.push(...hunk);
  }

  if (lines.length <= options.maxLines) {
    return { text: `${lines.join('\n')}\n`, truncated: false, totalHunks: hunks.length };
  }

  const kept = lines.slice(0, options.maxLines);
  kept.push(
    `!! TRUNCATED: showing ${String(options.maxLines)} of ${String(lines.length)} diff lines across ` +
      `${String(hunks.length)} hunk(s). Raise the line cap to see the rest — nothing below this point was examined.`,
  );
  return { text: `${kept.join('\n')}\n`, truncated: true, totalHunks: hunks.length };
}

/**
 * Positional fallback used when an LCS is refused.
 *
 * @param beforeLines - Earlier lines
 * @param afterLines - Later lines
 * @param maxLines - Cap on emitted rows
 * @param reason - Why the LCS was refused, stated verbatim in the output
 * @returns A report that names itself as positional, always `truncated`
 */
function renderPositionalReport(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  maxLines: number,
  reason: string,
): { text: string; truncated: boolean; totalHunks: number } {
  const lines: string[] = [
    `!! TRUNCATED: no diff was computed — ${reason}.`,
    '!! What follows is a POSITIONAL report, not a diff: a single inserted line makes every later line differ.',
  ];

  const shared = Math.min(beforeLines.length, afterLines.length);
  let differing = 0;
  for (let index = 0; index < shared; index += 1) {
    if (beforeLines[index] === afterLines[index]) {
      continue;
    }
    differing += 1;
    if (lines.length + 2 <= maxLines) {
      lines.push(
        `-${String(index + 1)}: ${beforeLines[index] ?? ''}`,
        `+${String(index + 1)}: ${afterLines[index] ?? ''}`,
      );
    }
  }
  lines.push(
    `!! ${String(differing)} position(s) differ; ${String(Math.abs(beforeLines.length - afterLines.length))} ` +
      'line(s) of length difference are not shown.',
  );

  return { text: `${lines.join('\n')}\n`, truncated: true, totalHunks: differing };
}

/**
 * Compute a line-level diff, or refuse when the LCS table would be too large.
 *
 * @param beforeLines - Earlier lines
 * @param afterLines - Later lines
 * @returns The ops with line numbers assigned, or `null` when over budget
 */
function computeOps(beforeLines: readonly string[], afterLines: readonly string[]): DiffOp[] | null {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middleBefore = beforeLines.slice(prefix, beforeLines.length - suffix);
  const middleAfter = afterLines.slice(prefix, afterLines.length - suffix);
  if ((middleBefore.length + 1) * (middleAfter.length + 1) > LCS_MAX_CELLS) {
    return null;
  }

  const raw: RawOp[] = [
    ...beforeLines.slice(0, prefix).map((text): RawOp => ({ kind: ' ', text })),
    ...lcsOps(middleBefore, middleAfter),
    ...beforeLines.slice(beforeLines.length - suffix).map((text): RawOp => ({ kind: ' ', text })),
  ];
  return assignLineNumbers(raw);
}

/**
 * Longest-common-subsequence alignment of two line arrays.
 *
 * @param a - Earlier lines, already trimmed of the common prefix and suffix
 * @param b - Later lines, likewise
 * @returns Ops in output order
 */
function lcsOps(a: readonly string[], b: readonly string[]): RawOp[] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let x = a.length - 1; x >= 0; x -= 1) {
    for (let y = b.length - 1; y >= 0; y -= 1) {
      table[x * width + y] =
        a[x] === b[y]
          ? (table[(x + 1) * width + y + 1] ?? 0) + 1
          : Math.max(table[(x + 1) * width + y] ?? 0, table[x * width + y + 1] ?? 0);
    }
  }
  return backtrack(a, b, table, width);
}

/**
 * Walk the filled LCS table from the origin, emitting ops in output order.
 *
 * @param a - Earlier lines
 * @param b - Later lines
 * @param table - Filled LCS length table
 * @param width - Row stride of the table
 * @returns Ops in output order
 */
function backtrack(
  a: readonly string[],
  b: readonly string[],
  table: Uint32Array,
  width: number,
): RawOp[] {
  const ops: RawOp[] = [];
  let x = 0;
  let y = 0;
  while (x < a.length && y < b.length) {
    if (a[x] === b[y]) {
      ops.push({ kind: ' ', text: a[x] ?? '' });
      x += 1;
      y += 1;
    } else if ((table[(x + 1) * width + y] ?? 0) >= (table[x * width + y + 1] ?? 0)) {
      ops.push({ kind: '-', text: a[x] ?? '' });
      x += 1;
    } else {
      ops.push({ kind: '+', text: b[y] ?? '' });
      y += 1;
    }
  }
  for (; x < a.length; x += 1) {
    ops.push({ kind: '-', text: a[x] ?? '' });
  }
  for (; y < b.length; y += 1) {
    ops.push({ kind: '+', text: b[y] ?? '' });
  }
  return ops;
}

/**
 * Attach 1-based per-side line numbers to a raw op sequence.
 *
 * @param raw - Ops in output order
 * @returns The same ops with `aLine` / `bLine` filled in
 */
function assignLineNumbers(raw: readonly RawOp[]): DiffOp[] {
  let aLine = 0;
  let bLine = 0;
  return raw.map((op) => {
    const consumesBefore = op.kind !== '+';
    const consumesAfter = op.kind !== '-';
    if (consumesBefore) {
      aLine += 1;
    }
    if (consumesAfter) {
      bLine += 1;
    }
    return {
      kind: op.kind,
      text: op.text,
      aLine: consumesBefore ? aLine : 0,
      bLine: consumesAfter ? bLine : 0,
    };
  });
}

/**
 * Group changed ops into unified-diff hunks with surrounding context.
 *
 * @param ops - The full op sequence
 * @param context - Unchanged lines to keep on each side of a run of changes
 * @returns One array of rendered lines per hunk, header first
 */
function buildHunks(ops: readonly DiffOp[], context: number): string[][] {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const [index, op] of ops.entries()) {
    if (op.kind === ' ') {
      continue;
    }
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map((range) => renderHunk(ops, range.start, range.end));
}

/**
 * Render one hunk, header included.
 *
 * @param ops - The full op sequence
 * @param start - First op index in the hunk
 * @param end - Last op index in the hunk
 * @returns The hunk's lines
 */
function renderHunk(ops: readonly DiffOp[], start: number, end: number): string[] {
  const slice = ops.slice(start, end + 1);
  const aLines = slice.filter((op) => op.aLine > 0);
  const bLines = slice.filter((op) => op.bLine > 0);
  const aStart = aLines[0]?.aLine ?? 0;
  const bStart = bLines[0]?.bLine ?? 0;

  return [
    `@@ -${String(aStart)},${String(aLines.length)} +${String(bStart)},${String(bLines.length)} @@`,
    ...slice.map((op) => `${op.kind}${op.text}`),
  ];
}
