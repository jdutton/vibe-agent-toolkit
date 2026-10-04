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
 * an unmeasured row, findings newly itemized — and matched as a MULTISET against
 * the observed ones, so "declared two added findings, one occurred" is one
 * unused declaration, not a pass.
 *
 * ## A finding whose location cannot be committed
 *
 * A finding is declared by its full identity, location included. A location is
 * a path inside the subject, and a subject's paths can spell what this file
 * must never hold — who the subject is. So a declared finding names its
 * location EITHER as `location` or as `locationDigest`, the SHA-256 of it
 * (`locationDigest()` in `extract.ts`; a compare prints it beside every
 * observed finding). Both pin the same identity: a finding of the same code and
 * severity anywhere else is undeclared, and the declaration is unused.
 *
 * ## A changelog reference names one bullet
 *
 * `changelog: <file>#<id>` resolves to the ONE bullet of that file carrying the
 * marker `<!-- verdict-delta:<id> -->` ({@link bulletAnchors}). An id no bullet
 * carries, or two do, is a refusal. A heading is not a target: a section holds
 * hundreds of bullets, and a reference to it would vouch for none of them.
 */

import { readFileSync } from 'node:fs';

import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { FINDING_SEVERITIES, type FindingKey, findingIdentity, FindingKeySchema, locationDigest } from './extract.js';
import { multisetDifference } from './multiset.js';
import { readYamlDocument, type Validated, validateDocument } from './yaml-file.js';

/** What a deltas document is, in a refusal. */
const DELTAS_FILE = 'a verdict deltas file';

/** The lab package root; this module sits three directories below it in `src/` and in `dist/` alike. */
const LAB_ROOT = safePath.resolve(import.meta.dirname, '..', '..', '..');

/**
 * The committed deltas file — resolved from the lab package, never the cwd, so
 * `verdict compare` means one file wherever it is run from.
 */
export const COMMITTED_VERDICT_DELTAS = safePath.join(LAB_ROOT, 'data', 'verdict-deltas.yaml');

/** The repository root, which a deltas entry's changelog reference is relative to. */
export const CHANGELOG_REFERENCE_ROOT = safePath.resolve(LAB_ROOT, '..', '..');

/** A finding named by the digest of its location — see this module's docstring. */
export interface FindingDigestKey {
  readonly code: string;
  readonly severity: FindingKey['severity'];
  /** `locationDigest(location)`: 64 lowercase hex characters. */
  readonly locationDigest: string;
  readonly scope: string | null;
}

/** A finding as a delta names it: by its location (always, when observed), or by that location's digest. */
export type DeclaredFinding = FindingKey | FindingDigestKey;

/** Runtime schema for {@link DeclaredFinding}. Each form is strict, so a finding naming both is refused. */
const DeclaredFindingSchema: z.ZodType<DeclaredFinding> = z.union([
  FindingKeySchema,
  z
    .object({
      code: z.string(),
      severity: z.enum(FINDING_SEVERITIES),
      locationDigest: z.string().regex(/^[0-9a-f]{64}$/, 'a locationDigest is the SHA-256 of the location, 64 lowercase hex characters'),
      scope: z.string().nullable(),
    })
    .strict(),
]);

/** One kind of difference between two arms' verdicts on one (alias, verb) row. */
export type DeltaChange =
  | { readonly kind: 'exit'; readonly from: number; readonly to: number }
  | { readonly kind: 'finding-added'; readonly finding: DeclaredFinding }
  | { readonly kind: 'finding-removed'; readonly finding: DeclaredFinding }
  /**
   * The refusal codes a row's document published differ between the arms
   * (`refusalCodes` in `extract.ts`), in document order. Read only on a row that
   * measured nothing, where it and the exit code are the only data.
   */
  | { readonly kind: 'refusal'; readonly from: readonly string[]; readonly to: readonly string[] }
  /** Layer 2: the normalized documents differ. */
  | { readonly kind: 'document' }
  /**
   * The row measured nothing in at least one arm — the verb did not run, exited
   * 2, or printed stdout the lab could not parse. Two unmeasured arms trivially
   * "agree", so this is a delta in its own right: never read as "no change".
   */
  | { readonly kind: 'unmeasured' }
  /**
   * The baseline published some findings only as tallies (`publishedTallies`
   * in `extract.ts`) and the candidate itemizes exactly those: per code and per
   * severity it adds as many as were tallied, removes none, and tallies nothing
   * itself (`itemizedTallies` in `compare.ts`). Observed INSTEAD of one
   * `finding-added` per covered finding. It covers only codes the baseline
   * tallied — every other added or removed finding on the row is still observed
   * one by one — and when a count disagrees it is not observed at all.
   */
  | { readonly kind: 'findings-itemized' };

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
              // The id after `#` is spelled as BULLET_MARKER spells it.
              /^(?:\.changes\/[a-z0-9-]+\.md|CHANGELOG\.md)#[a-z0-9][a-z0-9-]*$/,
              "a changelog reference is '.changes/<fragment>.md#<id>' or 'CHANGELOG.md#<id>', the id of one bullet's verdict-delta marker",
            ),
          exit: z.object({ from: z.number().int(), to: z.number().int() }).strict().optional(),
          refusal: z.object({ from: z.array(z.string().min(1)), to: z.array(z.string().min(1)) }).strict().optional(),
          findingsAdded: z.array(DeclaredFindingSchema).default([]),
          findingsRemoved: z.array(DeclaredFindingSchema).default([]),
          document: z.literal('reshaped').optional(),
          unmeasured: z.literal(true).optional(),
          findings: z.literal('itemized').optional(),
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
    refusals.push(
      `REFUSED: ${at} names verb '${entry.verb}', which subject '${entry.subject}' did not run.`,
    );
  }
  if (expandEntry(entry).length === 0) {
    refusals.push(`REFUSED: ${at} declares nothing — no exit, refusal, findings, document, unmeasured or itemized findings.`);
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
    ...(entry.refusal === undefined ? [] : [{ kind: 'refusal' as const, from: entry.refusal.from, to: entry.refusal.to }]),
    ...entry.findingsAdded.map((finding) => ({ kind: 'finding-added' as const, finding })),
    ...entry.findingsRemoved.map((finding) => ({ kind: 'finding-removed' as const, finding })),
    ...(entry.document === undefined ? [] : [{ kind: 'document' as const }]),
    ...(entry.unmeasured === undefined ? [] : [{ kind: 'unmeasured' as const }]),
    ...(entry.findings === undefined ? [] : [{ kind: 'findings-itemized' as const }]),
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
 * The identity a finding is matched on whichever way it was named: its
 * location is compared BY DIGEST, so a declaration that holds only the digest
 * and an observation that holds the path key identically.
 *
 * @param finding - A finding, by location or by location digest
 * @returns Its identity fields, in order — `null` where there is no location
 */
function declaredFindingIdentity(finding: DeclaredFinding): readonly [string, string, string | null, string | null] {
  if ('locationDigest' in finding) return [finding.code, finding.severity, finding.locationDigest, finding.scope];
  const [code, severity, location, scope] = findingIdentity(finding);
  return [code, severity, location === null ? null : locationDigest(location), scope];
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
      return [change.kind, ...declaredFindingIdentity(change.finding)];
    }
    case 'refusal': {
      return [change.kind, change.from, change.to];
    }
    case 'document':
    case 'unmeasured':
    case 'findings-itemized': {
      return [change.kind];
    }
  }
}

/**
 * Refuse every entry whose `changelog` reference does not name exactly one bullet.
 *
 * Pure: the caller reads the referenced files and hands their text in, keyed by
 * the path as the entry wrote it (`.changes/x.md`, `CHANGELOG.md`). A file the
 * caller could not find is simply absent from the map.
 *
 * @param declared - The deltas file
 * @param sources - Referenced file path → its markdown text
 * @returns One refusal per unresolvable or ambiguous reference
 */
export function changelogRefusals(declared: VerdictDeltas, sources: ReadonlyMap<string, string>): string[] {
  const refusals: string[] = [];
  const anchors = new Map<string, ReadonlyMap<string, number>>();
  for (const [index, entry] of declared.deltas.entries()) {
    const hash = entry.changelog.indexOf('#');
    const file = entry.changelog.slice(0, hash);
    const id = entry.changelog.slice(hash + 1);
    const text = sources.get(file);
    const at = `deltas[${String(index)}] (${entry.subject} / ${entry.verb})`;
    if (text === undefined) {
      refusals.push(`REFUSED: ${at} cites '${file}', which does not exist.`);
      continue;
    }
    const inFile = anchors.get(file) ?? bulletAnchors(text);
    anchors.set(file, inFile);
    const bullets = inFile.get(id) ?? 0;
    if (bullets === 0) {
      refusals.push(`REFUSED: ${at} cites '${entry.changelog}', but '${file}' has no bullet carrying '<!-- verdict-delta:${id} -->'.`);
    } else if (bullets > 1) {
      refusals.push(`REFUSED: ${at} cites '${entry.changelog}', but ${String(bullets)} bullets carry that id in '${file}'; a reference names ONE.`);
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

/** A bullet's marker: `<!-- verdict-delta:<id> -->`, the id as a `changelog` reference spells it after `#`. */
const BULLET_MARKER = /<!-- verdict-delta:([a-z0-9][a-z0-9-]*) -->/g;

/**
 * The ids a changelog file's BULLETS carry, and how many bullets carry each.
 *
 * A bullet is a line starting `- ` plus the indented lines that continue it —
 * the shape `.changes/README.md` defines and `validate-structure` enforces. A
 * marker anywhere else (under a heading, in prose) belongs to no bullet and is
 * not counted. An id is counted once per bullet however often that bullet
 * repeats it, so the count is "how many bullets", which must be exactly one.
 *
 * @param markdown - The file's text
 * @returns Id → the number of bullets carrying it
 */
export function bulletAnchors(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  let bullet: Set<string> | null = null;
  const close = (): void => {
    for (const id of bullet ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    bullet = null;
  };
  for (const line of markdown.split('\n')) {
    if (line.startsWith('- ')) {
      close();
      bullet = new Set();
    } else if (!(line.startsWith(' ') || line.startsWith('\t')) && line.trim() !== '') {
      close();
    }
    for (const match of line.matchAll(BULLET_MARKER)) {
      const [, id] = match;
      if (id !== undefined) bullet?.add(id);
    }
  }
  close();
  return counts;
}
