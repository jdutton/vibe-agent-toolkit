/**
 * The committed expected-delta file, and the reconciliation that checks it
 * BOTH WAYS against what a compare observed.
 *
 * ## Both directions fail
 *
 * An observed delta no entry declares is a regression nobody explained. A
 * declared delta that did not occur is a claim — "this release changes X" —
 * that the build under test does not make true; left standing it would excuse
 * the same change on a later run where it arrives by accident. So
 * {@link reconcileDeltas} reports both, and the compare fails on either.
 *
 * ## Every entry is validated, none is filtered
 *
 * An entry naming an alias the run did not cover, or a verb that alias did not
 * run, is a REFUSAL — not skipped. There is no `--subjects-subset` escape hatch:
 * a partial run uses a partial subjects file, and the compare still sees every
 * declared entry. A filter here would be the quiet path by which a stale entry
 * outlives the subject it was written for.
 *
 * ## One file, one baseline
 *
 * The file names the baseline instrument version every entry is against
 * (`baseline`). A compare whose baseline arm is a different version refuses the
 * whole file: a delta is only meaningful relative to what it moved away from.
 *
 * ## Granularity
 *
 * An entry is expanded into one {@link DeclaredDelta} per thing it declares —
 * the exit move, each added finding, each removed finding, a reshaped document,
 * an unmeasured row — and matched as a MULTISET against the observed ones, so
 * "declared two added findings, one occurred" is one unused declaration, not a
 * pass.
 */

import { readFileSync } from 'node:fs';

import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { type FindingKey, findingIdentity, FindingKeySchema } from './extract.js';
import { multisetDifference } from './multiset.js';
import { readYamlDocument, type Validated, validateDocument } from './yaml-file.js';

/** What a deltas document is, in a refusal. */
const DELTAS_FILE = 'a verdict deltas file';

/** One kind of difference between two arms' verdicts on one (alias, verb) row. */
export type DeltaChange =
  | { readonly kind: 'exit'; readonly from: number; readonly to: number }
  | { readonly kind: 'finding-added'; readonly finding: FindingKey }
  | { readonly kind: 'finding-removed'; readonly finding: FindingKey }
  /** Layer 2: the normalized documents differ. */
  | { readonly kind: 'document' }
  /**
   * The row measured nothing in at least one arm — the verb did not run, exited
   * 2, or printed stdout the lab could not parse. Two unmeasured arms trivially
   * "agree", so this is a delta in its own right: never read as "no change".
   */
  | { readonly kind: 'unmeasured' };

/** A difference a compare saw. */
export interface ObservedDelta {
  readonly subject: string;
  readonly verb: string;
  readonly change: DeltaChange;
  /** Evidence for the render — a diff excerpt, an unmeasured reason. Never part of the match. */
  readonly detail: readonly string[];
}

/** A difference the deltas file declares, one per declared item. */
export interface DeclaredDelta {
  readonly subject: string;
  readonly verb: string;
  readonly change: DeltaChange;
  readonly changelog: string;
  readonly reason: string;
}

/** The committed deltas file — see this module's docstring. */
export const VerdictDeltasSchema = z
  .object({
    /** The baseline `InstrumentVersion.version` every entry is against. */
    baseline: z.string().min(1),
    deltas: z.array(
      z
        .object({
          subject: z.string(),
          verb: z.string(),
          changelog: z
            .string()
            .regex(
              /^\.changes\/[a-z0-9-]+\.md#.+$|^CHANGELOG\.md#.+$/,
              "a changelog reference is '.changes/<fragment>.md#<anchor>' or 'CHANGELOG.md#<anchor>'",
            ),
          exit: z.object({ from: z.number().int(), to: z.number().int() }).strict().optional(),
          findingsAdded: z.array(FindingKeySchema).default([]),
          findingsRemoved: z.array(FindingKeySchema).default([]),
          document: z.literal('reshaped').optional(),
          unmeasured: z.literal(true).optional(),
          reason: z.string().min(10),
        })
        .strict(),
    ),
  })
  .strict();

/** A parsed deltas file. */
export type VerdictDeltas = z.infer<typeof VerdictDeltasSchema>;

/** One entry of a parsed deltas file. */
type DeltaEntry = VerdictDeltas['deltas'][number];

/** A parse that either produced a deltas file or says exactly why not. */
export type VerdictDeltasResult =
  | { readonly ok: true; readonly deltas: VerdictDeltas }
  | { readonly ok: false; readonly refusal: string };

/**
 * Validate an already-read deltas document.
 *
 * @param value - The document's root value
 * @returns The deltas, or a refusal naming every issue
 */
export function parseVerdictDeltas(value: unknown): VerdictDeltasResult {
  return asDeltas(validateDocument(VerdictDeltasSchema, value, DELTAS_FILE));
}

/**
 * Read and validate a deltas file.
 *
 * @param file - Path to the YAML deltas file
 * @returns The deltas, or a refusal
 */
export function loadVerdictDeltas(file: string): VerdictDeltasResult {
  return asDeltas(readYamlDocument(file, VerdictDeltasSchema, DELTAS_FILE));
}

/**
 * @param validated - A validated deltas document, or its refusal
 * @returns The same, keyed as {@link VerdictDeltasResult}
 */
function asDeltas(validated: Validated<VerdictDeltas>): VerdictDeltasResult {
  return validated.ok ? { ok: true, deltas: validated.value } : validated;
}

/** What the run covered, which every declared entry is validated against. */
export interface ReconcileRun {
  /** The baseline arm's `InstrumentVersion.version`. */
  readonly baseline: string;
  readonly aliases: ReadonlySet<string>;
  /** Row names each alias ran — the values a deltas entry's `verb` may take. */
  readonly verbsByAlias: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The outcome of reconciling observed against declared deltas. */
export interface Reconciliation {
  /** Observed, and no declaration accounts for it. */
  readonly undeclared: ObservedDelta[];
  /** Declared, and nothing observed accounts for it. */
  readonly unused: DeclaredDelta[];
  /** The deltas file cannot be judged against this run at all, or an entry is malformed for it. */
  readonly refusals: string[];
}

/**
 * Reconcile both ways — see this module's docstring.
 *
 * @param observed - Every delta the compare saw
 * @param declared - The committed deltas file
 * @param run - What the run covered
 * @returns Undeclared, unused, and refusals
 */
export function reconcileDeltas(
  observed: readonly ObservedDelta[],
  declared: VerdictDeltas,
  run: ReconcileRun,
): Reconciliation {
  const refusals: string[] = [];
  if (declared.baseline !== run.baseline) {
    refusals.push(
      `REFUSED: the deltas file is against baseline '${declared.baseline}', but this compare's ` +
        `baseline arm is '${run.baseline}'. Every entry describes a move away from one build; ` +
        're-baseline the file (and re-review every entry) or compare against the build it names.',
    );
  }
  refusals.push(...declared.deltas.flatMap((entry, index) => entryRefusals(entry, index, declared.deltas, run)));

  const matched = multisetDifference(declared.deltas.flatMap(expandEntry), observed, deltaKey);
  return { undeclared: matched.onlyRight, unused: matched.onlyLeft, refusals };
}

/**
 * Every reason one entry cannot be judged against this run.
 *
 * @param entry - The entry
 * @param index - Its position, for the message
 * @param all - Every entry, to catch a duplicate (alias, verb)
 * @param run - What the run covered
 * @returns Zero or more refusals
 */
function entryRefusals(
  entry: DeltaEntry,
  index: number,
  all: readonly DeltaEntry[],
  run: ReconcileRun,
): string[] {
  const at = `deltas[${String(index)}] (${entry.subject} / ${entry.verb})`;
  const refusals: string[] = [];
  if (!run.aliases.has(entry.subject)) {
    refusals.push(
      `REFUSED: ${at} names subject '${entry.subject}', which this run's subject set does not ` +
        'define. A partial run uses a partial subjects file AND a deltas file that matches it.',
    );
  } else if (run.verbsByAlias.get(entry.subject)?.has(entry.verb) !== true) {
    refusals.push(`REFUSED: ${at} names verb '${entry.verb}', which subject '${entry.subject}' did not run.`);
  }
  if (expandEntry(entry).length === 0) {
    refusals.push(`REFUSED: ${at} declares nothing — no exit, findings, document or unmeasured.`);
  }
  if (all.findIndex((other) => other.subject === entry.subject && other.verb === entry.verb) !== index) {
    refusals.push(`REFUSED: ${at} repeats an earlier entry's (subject, verb); declare each row once.`);
  }
  return refusals;
}

/**
 * Expand one entry into one declaration per declared item.
 *
 * @param entry - The entry
 * @returns Its declarations
 */
function expandEntry(entry: DeltaEntry): DeclaredDelta[] {
  const changes: DeltaChange[] = [
    ...(entry.exit === undefined ? [] : [{ kind: 'exit' as const, from: entry.exit.from, to: entry.exit.to }]),
    ...entry.findingsAdded.map((finding) => ({ kind: 'finding-added' as const, finding })),
    ...entry.findingsRemoved.map((finding) => ({ kind: 'finding-removed' as const, finding })),
    ...(entry.document === undefined ? [] : [{ kind: 'document' as const }]),
    ...(entry.unmeasured === undefined ? [] : [{ kind: 'unmeasured' as const }]),
  ];
  return changes.map((change) => ({
    subject: entry.subject,
    verb: entry.verb,
    change,
    changelog: entry.changelog,
    reason: entry.reason,
  }));
}

/**
 * The identity two deltas are matched on: row plus change, in a fixed field
 * order so an observed and a declared delta built differently key identically.
 *
 * @param delta - Either side
 * @returns A string key
 */
function deltaKey(delta: { readonly subject: string; readonly verb: string; readonly change: DeltaChange }): string {
  return JSON.stringify([delta.subject, delta.verb, changeKey(delta.change)]);
}

/**
 * @param change - One change
 * @returns Its fields as a fixed-order array
 */
function changeKey(change: DeltaChange): readonly unknown[] {
  switch (change.kind) {
    case 'exit': {
      return [change.kind, change.from, change.to];
    }
    case 'finding-added':
    case 'finding-removed': {
      return [change.kind, ...findingIdentity(change.finding)];
    }
    case 'document':
    case 'unmeasured': {
      return [change.kind];
    }
  }
}

/**
 * Refuse every entry whose `changelog` reference names no heading that exists.
 *
 * Pure: the caller reads the referenced files and hands their text in, keyed by
 * the path as the entry wrote it (`.changes/x.md`, `CHANGELOG.md`). A file the
 * caller could not find is simply absent from the map.
 *
 * @param declared - The deltas file
 * @param sources - Referenced file path → its markdown text
 * @returns One refusal per unresolvable reference
 */
export function changelogRefusals(declared: VerdictDeltas, sources: ReadonlyMap<string, string>): string[] {
  const refusals: string[] = [];
  for (const [index, entry] of declared.deltas.entries()) {
    const hash = entry.changelog.indexOf('#');
    const file = entry.changelog.slice(0, hash);
    const anchor = entry.changelog.slice(hash + 1);
    const text = sources.get(file);
    const at = `deltas[${String(index)}] (${entry.subject} / ${entry.verb})`;
    if (text === undefined) {
      refusals.push(`REFUSED: ${at} cites '${file}', which does not exist.`);
    } else if (!headingAnchors(text).has(anchor)) {
      refusals.push(`REFUSED: ${at} cites '${entry.changelog}', but '${file}' has no heading with anchor '${anchor}'.`);
    }
  }
  return refusals;
}

/**
 * Read every changelog file a deltas file cites, for {@link changelogRefusals}.
 *
 * @param declared - The deltas file
 * @param repoRoot - The repository root the references are relative to
 * @returns Cited path → text, for every cited file that could be read
 */
export function readChangelogSources(declared: VerdictDeltas, repoRoot: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of declared.deltas) {
    const file = entry.changelog.slice(0, entry.changelog.indexOf('#'));
    if (sources.has(file)) continue;
    try {
      sources.set(file, readFileSync(safePath.join(repoRoot, file), 'utf-8'));
    } catch (error) {
      // Absent is an answer changelogRefusals turns into a refusal; any other
      // failure to read is not "absent" and must not be reported as one.
      if (!isPathAbsentError(error)) throw error;
    }
  }
  return sources;
}

/**
 * The anchors a markdown file's headings produce, GitHub-style: lowercased,
 * punctuation dropped, spaces to hyphens, a repeated heading suffixed `-1`, `-2`.
 *
 * @param markdown - The file's text
 * @returns Every heading anchor it defines
 */
export function headingAnchors(markdown: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of markdown.split('\n')) {
    const text = headingText(line);
    if (text === null) continue;
    const slug = text
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N} _-]/gu, '')
      .replaceAll(' ', '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${String(count)}`);
  }
  return anchors;
}

/**
 * @param line - One markdown line
 * @returns The ATX heading's text, or `null` when the line is not one
 */
function headingText(line: string): string | null {
  let level = 0;
  while (line[level] === '#') level += 1;
  if (level === 0 || level > 6 || line[level] !== ' ') return null;
  return line.slice(level + 1).trim();
}
