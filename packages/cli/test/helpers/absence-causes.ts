/**
 * The absence-cause enumeration (I1): every way a run can leave a pair or an
 * extent it could not compute, owned here as code, and the census that reads it.
 *
 * ## Membership
 *
 * A member is **a pair or extent VAT could not compute**. A true-empty fact (a
 * broken link, a dangling one), a legal state, and a decline Claude Code makes
 * too are exempt, each with its reason, so one broken link cannot make a refusing
 * reader refuse every query. Every code the static domain holds is classified
 * exactly once: a member or an exemption, never both, never neither.
 *
 * ## One classification order
 *
 * A row is classified by member signature first (kind-qualified), then by the
 * refusal-label rule (a `realization_conditions` code that is one of its own
 * extent's declared `refusals[].label`s, read from `zone_provenance` by
 * provenance, never by value), then by the exemption table, then by a member's
 * own exempt remainder. A row none of them classifies throws: the census never
 * reads an unknown code as a zero.
 *
 * ## Not here
 *
 * No member records a refusal code: which refusal each cause raises, and the
 * link to the fault classes, belongs to the reader that refuses on it, which
 * derives the code from the fault class rather than from this list.
 */

import {
  SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
  SKILL_REFUSED_DIRECTORY_TARGET,
  SKILL_REFUSED_GITIGNORED,
  SKILL_REFUSED_NAVIGATION_FILE,
  SKILL_REFUSED_PATTERN_MATCHED,
  SKILL_REFUSED_SKILL_DEFINITION,
} from '@vibe-agent-toolkit/agent-skills';
import {
  INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE,
  INVENTORY_REFUSED_DIRECTORY_TARGET,
  INVENTORY_REFUSED_GITIGNORED,
  INVENTORY_REFUSED_NAVIGATION_FILE,
  MANIFEST_UNREADABLE,
  PLUGIN_NOT_INSTALLED,
} from '@vibe-agent-toolkit/claude-marketplace';
import {
  BLOB_CONTENT_CHANGED,
  BLOB_NOT_TEXT,
  BLOB_PARSE_FAILED,
  BLOB_PARSE_LIMIT_EXCEEDED,
  BLOB_PARSE_WORKER_DIED,
  BLOB_REFUSAL_CONDITION_CODES,
  BLOB_UNREADABLE,
  CLOSURE_DEPTH_EXCEEDED,
  CLOSURE_REFERENCE_OUTSIDE_ROOT,
  CLOSURE_REFERENCE_UNRESOLVED,
  CLOSURE_ROOT_ABSENT,
  COLLECTION_MIME_CONFLICT,
  ContentStateSchema,
  EXTENT_DIRECTORY_UNLISTABLE,
  EXTENT_SYMLINK_NOT_REALIZED,
  EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
  EXTENT_SYMLINK_TARGET_UNREADABLE,
  EXTENT_SYMLINK_TARGET_UNRESOLVED,
  ExtentDeclarationSchema,
  notAdmittedIssues,
  notAdmittedRealizations,
  PACKAGE_NOT_INSTALLED,
  PACKAGE_RESOLUTION_FAILED,
  PACKAGE_SUBPATH_ABSENT,
  PACKAGE_SUBPATH_NOT_EXPORTED,
  REALIZATION_PATH_COLLISION,
  REALIZATION_PROMOTION_UNREADABLE,
  type ContentState,
  type ResourceRealizationRow,
} from '@vibe-agent-toolkit/resources';
import { REFUSAL_CODES } from '@vibe-agent-toolkit/schema';
import {
  absenceObservations,
  matchesAbsenceCause,
  type AbsenceObservation,
  type AbsenceRows,
  type AbsenceSignature,
} from '@vibe-agent-toolkit/utils/testing';

// ── The enumeration ─────────────────────────────────────────────────────────

/** Where a member is seeded: by the I0 harness, or (transitionally) by a package test that can plant it. */
type AbsenceTier = 'system' | 'lower';

/** One member: how it shows in rows, where it is seeded, and what a refusing reader must know of it. */
interface AbsenceMemberEntry {
  readonly signature: AbsenceSignature;
  readonly tier: AbsenceTier;
  /** The member's scope, as the reader that refuses on it must read it. */
  readonly scope: string;
  /** Why the rows of this code the signature does not match are exempt, for a code split by row shape. */
  readonly exemptRemainder?: string;
}

/** The `resolution_contexts.kind` of the filesystem extent. */
const FILESYSTEM_KIND = 'filesystem';
/** The `resolution_contexts.kind` of a package extent. */
const PACKAGE_KIND = 'package';

/** The domain key of a content state: `contentState:<state>`. */
function stateKey<const State extends ContentState>(state: State): `contentState:${State}` {
  return `contentState:${state}`;
}

/**
 * The members, keyed by their domain key (the code, or `contentState:<state>`).
 * A seed's cause is typed as a key of this table, so a seed naming an exempt
 * code does not typecheck.
 */
export const ABSENCE_MEMBERS = {
  [BLOB_PARSE_LIMIT_EXCEEDED]: {
    signature: { code: BLOB_PARSE_LIMIT_EXCEEDED },
    tier: 'system',
    scope: 'A blob whose parse this run stopped at a limit: per run, never stored.',
  },
  [stateKey('oversize')]: {
    signature: { contentState: 'oversize' },
    tier: 'system',
    scope: 'Any mime. Surfaces as RESOURCE_PARSE_LIMIT_EXCEEDED for a kind a parser reads, else as unreadable;'
      + ' a refusing reader refuses on the row. The arm past MAX_DECODABLE_BYTES is the same row.',
  },
  [EXTENT_DIRECTORY_UNLISTABLE]: {
    signature: { code: EXTENT_DIRECTORY_UNLISTABLE, extentKind: FILESYSTEM_KIND },
    tier: 'system',
    scope: 'Only statements that reach ignored rows are refused on it: nothing beneath a gitignored directory is in a declared population.',
  },
  [EXTENT_SYMLINK_NOT_REALIZED]: {
    signature: { code: EXTENT_SYMLINK_NOT_REALIZED, extentKind: FILESYSTEM_KIND },
    tier: 'system',
    scope: 'VAT\'s own decline hides facts Claude Code reads through the link; only statements that reach the link\'s path are refused on it.',
  },
  [BLOB_UNREADABLE]: {
    signature: { code: BLOB_UNREADABLE },
    tier: 'lower',
    scope: 'A blob whose bytes the OS refused when it was derived.',
  },
  [BLOB_CONTENT_CHANGED]: {
    signature: { code: BLOB_CONTENT_CHANGED },
    tier: 'lower',
    scope: 'A blob whose bytes changed between keying and derivation.',
  },
  [BLOB_PARSE_FAILED]: {
    signature: { code: BLOB_PARSE_FAILED },
    tier: 'lower',
    scope: 'A blob whose parser threw on its bytes.',
  },
  [BLOB_PARSE_WORKER_DIED]: {
    signature: { code: BLOB_PARSE_WORKER_DIED },
    tier: 'lower',
    scope: 'A blob whose parse worker died: per run, never stored.',
  },
  [stateKey('unreadable')]: {
    signature: { contentState: 'unreadable' },
    tier: 'lower',
    scope: 'A realization whose read the OS refused when it was keyed.',
  },
  [PACKAGE_RESOLUTION_FAILED]: {
    signature: { code: PACKAGE_RESOLUTION_FAILED, extentKind: PACKAGE_KIND },
    tier: 'lower',
    scope: 'A package or subpath whose resolution failed for a reason that is neither absence nor an exports exclusion.',
  },
  [PACKAGE_SUBPATH_NOT_EXPORTED]: {
    signature: { code: PACKAGE_SUBPATH_NOT_EXPORTED, extentKind: PACKAGE_KIND, unlocatedPackage: true },
    tier: 'lower',
    scope: 'The package-level row only: an exports map that hides the package\'s own manifest, so the package was not located.',
    exemptRemainder: 'The subpath-level row is a declared exclusion: the located package\'s exports map hides that one subpath.',
  },
  [MANIFEST_UNREADABLE]: {
    signature: { code: MANIFEST_UNREADABLE },
    tier: 'lower',
    scope: 'The OS refusing a plugin or marketplace manifest. Its malformed-JSON and failed-schema arms are corpus facts'
      + ' carried in the same row shape (only the message differs), so the census counts them here; a refusing'
      + ' reader must tell the read-fault arm apart by a column before refusing on it, never by message.',
  },
} as const satisfies Readonly<Record<string, AbsenceMemberEntry>>;

/** A member's domain key. */
export type AbsenceMember = keyof typeof ABSENCE_MEMBERS;

/** Every member, in enumeration order. */
export const ABSENCE_MEMBER_KEYS = Object.keys(ABSENCE_MEMBERS) as readonly AbsenceMember[];

/** A member's entry, typed as the general shape (`as const` narrows each to its own literals). */
export function memberEntry(member: AbsenceMember): AbsenceMemberEntry {
  return ABSENCE_MEMBERS[member];
}

/** Why a true-empty fact is exempt: there is nothing absent, only nothing there. */
const TRUE_EMPTY = 'A true-empty fact: the rows say what is there, and nothing is missing from them.';

/** Why an outside-the-root condition is exempt. */
const OUTSIDE_ROOT = 'Outside the root: the root defines the population, so no run could compute a fact there,'
  + ' and Claude Code skips such a rules link too.';

/** Why a declared refusal label is exempt; the label rule classifies these rows at runtime. */
const REFUSAL_LABEL = 'A declared refusal label: a closure extent refused the path by its own declaration.'
  + ' At runtime its rows are classified by provenance (the label rule), which runs first.';

/**
 * Every code (or content state) in the static domain that is not a member, with why.
 * Disjoint from {@link ABSENCE_MEMBERS} by key.
 */
export const ABSENCE_EXEMPTIONS: Readonly<Record<string, string>> = {
  [BLOB_NOT_TEXT]: TRUE_EMPTY,
  [CLOSURE_REFERENCE_UNRESOLVED]: `${TRUE_EMPTY} A broken link.`,
  [EXTENT_SYMLINK_TARGET_UNRESOLVED]: `${TRUE_EMPTY} A dangling link.`,
  [CLOSURE_ROOT_ABSENT]: TRUE_EMPTY,
  [PACKAGE_SUBPATH_ABSENT]: TRUE_EMPTY,
  [PLUGIN_NOT_INSTALLED]: 'A legal state, per its own docs: an uninstalled plugin has no realization to compute.',
  [PACKAGE_NOT_INSTALLED]: 'A legal state, per its own docs: a declared, uninstalled dependency has no realization to compute.',
  [CLOSURE_REFERENCE_OUTSIDE_ROOT]: OUTSIDE_ROOT,
  [EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT]: OUTSIDE_ROOT,
  [EXTENT_SYMLINK_TARGET_UNREADABLE]: 'A declared decline: Claude Code reads nothing through the link either.',
  [CLOSURE_DEPTH_EXCEEDED]: 'A declared bound: the extent stops where its declaration says.',
  [REALIZATION_PATH_COLLISION]: 'One file on disk at that path, its facts computed.',
  [COLLECTION_MIME_CONFLICT]: 'A conflict between declarations, not an absence.',
  [REALIZATION_PROMOTION_UNREADABLE]: 'Explains a contentState:unreadable row, which is the member.',
  HTML_PARSE_ERROR: 'A fact about a derived blob.',
  UNRESOLVED_REFERENCE: 'A fact about a derived blob.',
  [stateKey('keyed')]: 'The bytes were read and keyed.',
  [stateKey('deferred')]: 'No consumer asked for the bytes yet: the demand-driven design working.',
  [stateKey('none')]: 'No bytes to key: an absent path, a directory, a dangling link.',
  [SKILL_REFUSED_AGENT_INSTRUCTION_FILE]: REFUSAL_LABEL,
  [SKILL_REFUSED_DIRECTORY_TARGET]: REFUSAL_LABEL,
  [SKILL_REFUSED_GITIGNORED]: REFUSAL_LABEL,
  [SKILL_REFUSED_NAVIGATION_FILE]: REFUSAL_LABEL,
  [SKILL_REFUSED_PATTERN_MATCHED]: REFUSAL_LABEL,
  [SKILL_REFUSED_SKILL_DEFINITION]: REFUSAL_LABEL,
  [INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE]: REFUSAL_LABEL,
  [INVENTORY_REFUSED_DIRECTORY_TARGET]: REFUSAL_LABEL,
  [INVENTORY_REFUSED_GITIGNORED]: REFUSAL_LABEL,
  [INVENTORY_REFUSED_NAVIGATION_FILE]: REFUSAL_LABEL,
};

/** The domain key a code signature or an observation is classified under. */
function domainKeyOf(observation: AbsenceObservation): string {
  return observation.table === 'resource_realizations' ? stateKey(observation.contentState as ContentState) : observation.code;
}

/** Every content state's domain key. */
export const CONTENT_STATE_KEYS: readonly string[] = ContentStateSchema.options.map((state) => stateKey(state));

// ── Surfaced codes, asked of production ─────────────────────────────────────

/** A content key for a probe row: well-formed, and naming no blob. */
const PROBE_CONTENT_KEY = `markdown.${'0'.repeat(64)}`;
const PROBE_ROOT = process.cwd();

/** The mimes a state is probed under: one a parser reads, and none. */
const PROBE_MIMES: readonly (string | null)[] = ['text/markdown', null];

/** A probe realization at one path. */
function probeRealization(fields: Pick<ResourceRealizationRow, 'contentKey' | 'contentState' | 'mime'>): ResourceRealizationRow {
  return { path: 'probe', ...fields } as ResourceRealizationRow;
}

/** The finding codes the not-admitted contract reports for one projection's worth of probe rows. */
function findingCodesOf(rows: Parameters<typeof notAdmittedRealizations>[0]): string[] {
  const log = notAdmittedRealizations(rows, PROBE_ROOT);
  return notAdmittedIssues(log, { locationRoot: PROBE_ROOT, consequence: 'probe' }).map((issue) => issue.code);
}

/**
 * The finding codes a member surfaces under, asked of production: a blob code
 * through `notAdmittedRealizations` over a keyed realization of a blob carrying
 * it, a state through a realization in that state under each probe mime. A
 * `realization_conditions` member surfaces under its own code, and its seed
 * proves that.
 *
 * @param member - The member
 * @returns Its surfaced codes, sorted and unique
 */
export function surfacedCodesOf(member: AbsenceMember): readonly string[] {
  const { signature } = memberEntry(member);
  let codes: string[];
  if ('contentState' in signature) {
    codes = PROBE_MIMES.flatMap((mime) => findingCodesOf({
      blobConditions: [],
      resourceRealizations: [probeRealization({ contentKey: null, contentState: signature.contentState as ContentState, mime })],
    }));
  } else if (BLOB_REFUSAL_CONDITION_CODES.includes(signature.code)) {
    codes = findingCodesOf({
      blobConditions: [{ blob: PROBE_CONTENT_KEY, code: signature.code, severity: 'error', message: 'probe', line: null }],
      resourceRealizations: [probeRealization({ contentKey: PROBE_CONTENT_KEY, contentState: 'keyed', mime: null })],
    });
  } else {
    codes = [signature.code];
  }
  return [...new Set(codes)].sort((left, right) => left.localeCompare(right));
}

const SURFACED: ReadonlyMap<AbsenceMember, readonly string[]> = new Map(ABSENCE_MEMBER_KEYS.map((member) => [member, surfacedCodesOf(member)]));
for (const [member, codes] of SURFACED) {
  if (codes.length === 0) throw new Error(`absence member ${member} surfaces under no finding code: the probe is broken`);
}

/**
 * The other members whose surfaced codes overlap this one's: what a seed of
 * this member must show zero rows of, since a finding cannot tell them apart.
 *
 * @param member - The member
 * @returns The siblings, in enumeration order
 */
export function siblingsOf(member: AbsenceMember): readonly AbsenceMember[] {
  const own = new Set(SURFACED.get(member));
  return ABSENCE_MEMBER_KEYS.filter((other) => other !== member && (SURFACED.get(other) ?? []).some((code) => own.has(code)));
}

/**
 * The members connected by shared surfaced codes, as one group per member: a
 * finding counts under its group, since its code alone cannot name the member.
 */
const GROUP_OF: ReadonlyMap<AbsenceMember, string> = (() => {
  const groupOfMember = new Map<AbsenceMember, string>();
  for (const start of ABSENCE_MEMBER_KEYS) {
    if (groupOfMember.has(start)) continue;
    // Everything reachable from `start` through shared surfaced codes.
    const reached = new Set<AbsenceMember>([start]);
    for (const member of reached) for (const sibling of siblingsOf(member)) reached.add(sibling);
    const key = ABSENCE_MEMBER_KEYS.filter((member) => reached.has(member)).join(' | ');
    for (const member of reached) groupOfMember.set(member, key);
  }
  return groupOfMember;
})();

/**
 * The group a member's findings count under.
 *
 * @param member - The member
 * @returns The group's key: its members, in enumeration order
 */
export function groupOf(member: AbsenceMember): string {
  const group = GROUP_OF.get(member);
  if (group === undefined) throw new Error(`absence member ${member} has no group`);
  return group;
}

/** Each surfaced finding code's group. */
const GROUP_OF_FINDING_CODE: ReadonlyMap<string, string> = new Map(
  ABSENCE_MEMBER_KEYS.flatMap((member) => (SURFACED.get(member) ?? []).map((code) => [code, groupOf(member)] as const)),
);

/** The census bucket of a refusing finding code no member surfaces. */
export const UNGROUPED = 'ungrouped';

/** Finding codes that refuse: the registry's refusal kind, and every code the not-admitted contract reports. */
const REFUSING_FINDING_CODES: ReadonlySet<string> = new Set<string>([...REFUSAL_CODES, ...GROUP_OF_FINDING_CODE.keys()]);

/**
 * The census bucket a finding code counts in: its group, `ungrouped` for a
 * refusing code no member surfaces, or undefined for a finding that is no refusal.
 *
 * @param code - A finding, error-envelope or `refused[]` code
 * @returns The bucket, or undefined
 */
export function findingBucket(code: string): string | undefined {
  const group = GROUP_OF_FINDING_CODE.get(code);
  if (group !== undefined) return group;
  return REFUSING_FINDING_CODES.has(code) ? UNGROUPED : undefined;
}

// ── Classifying a dump ──────────────────────────────────────────────────────

/** How one row was classified. */
type AbsenceClass =
  | { readonly member: AbsenceMember }
  | { readonly exempt: string };

/** The refusal labels each extent declares, by its `contextId`. */
type DeclaredLabels = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Each extent's declared refusal labels, read from `zone_provenance.parameterSet`
 * through `ExtentDeclarationSchema`; an extent whose parameters are no extent
 * declaration declares none.
 *
 * @param zoneProvenance - The rows, `parameterSet` as stored or as JSON text
 * @returns contextId to its labels
 */
function declaredLabelsOf(zoneProvenance: readonly { readonly contextId: string; readonly parameterSet: unknown }[]): DeclaredLabels {
  const labels = new Map<string, Set<string>>();
  for (const row of zoneProvenance) {
    const value: unknown = typeof row.parameterSet === 'string' ? JSON.parse(row.parameterSet) : row.parameterSet;
    const parsed = ExtentDeclarationSchema.safeParse(value);
    if (!parsed.success) continue;
    const own = labels.get(row.contextId) ?? new Set<string>();
    for (const rule of parsed.data.refusals) own.add(rule.label);
    labels.set(row.contextId, own);
  }
  return labels;
}

/** Which member's exempt remainder a code falls in, by code alone. */
const REMAINDER_OF: ReadonlyMap<string, string> = new Map(
  ABSENCE_MEMBER_KEYS.flatMap((member) => {
    const entry = memberEntry(member);
    return entry.exemptRemainder !== undefined && 'code' in entry.signature ? [[entry.signature.code, entry.exemptRemainder] as const] : [];
  }),
);

/**
 * Classify one observed row, in the one order: member signature, the label
 * rule, the exemption table, a member's exempt remainder.
 *
 * @param observation - The row
 * @param labels - The refusal labels each extent declares
 * @returns Its class
 * @throws When nothing classifies it, or a condition names an extent the rows do not carry
 */
function classifyAbsence(observation: AbsenceObservation, labels: DeclaredLabels): AbsenceClass {
  if (observation.table === 'realization_conditions' && observation.extentKind === null) {
    throw new Error(`realization_conditions row '${observation.code}' names extent '${observation.extentId}', which no resolution_contexts row carries: list that relation`);
  }
  const member = ABSENCE_MEMBER_KEYS.find((key) => matchesAbsenceCause(observation, memberEntry(key).signature));
  if (member !== undefined) return { member };
  if (observation.table === 'realization_conditions' && labels.get(observation.extentId)?.has(observation.code) === true) {
    return { exempt: REFUSAL_LABEL };
  }
  const key = domainKeyOf(observation);
  const exempt = ABSENCE_EXEMPTIONS[key] ?? REMAINDER_OF.get(key);
  if (exempt !== undefined) return { exempt };
  throw new Error(`${observation.table} '${key}' is neither an absence-cause member nor exempt: classify it in absence-causes.ts`);
}

/** The relations a dump must list for its rows to be classified. */
export const CLASSIFIED_RELATIONS = ['blob_conditions', 'resource_realizations', 'realization_conditions', 'resolution_contexts', 'zone_provenance'] as const;

/**
 * A dump's rows as the four tables a cause is observed in, plus each extent's labels.
 *
 * @param rowsOf - A relation's rows as JSON text, empty for a relation the dump does not list
 * @returns The rows and labels
 */
export function absenceRowsOfDump(rowsOf: (relation: (typeof CLASSIFIED_RELATIONS)[number]) => readonly string[]): { rows: AbsenceRows; labels: DeclaredLabels } {
  const parsed = <Row>(relation: (typeof CLASSIFIED_RELATIONS)[number]): Row[] => rowsOf(relation).map((row) => JSON.parse(row) as Row);
  return {
    rows: {
      blobConditions: parsed('blob_conditions'),
      resourceRealizations: parsed('resource_realizations'),
      realizationConditions: parsed('realization_conditions'),
      resolutionContexts: parsed('resolution_contexts'),
    },
    labels: declaredLabelsOf(parsed('zone_provenance')),
  };
}

/**
 * The member rows of a dump, counted by member; every row classified, and a
 * throw on one nothing classifies.
 *
 * @param rows - The dump's rows
 * @param labels - Each extent's declared labels
 * @returns Member to its row count, members with none absent
 */
export function memberRowCounts(rows: AbsenceRows, labels: DeclaredLabels): Partial<Record<AbsenceMember, number>> {
  const counts: Partial<Record<AbsenceMember, number>> = {};
  for (const observation of absenceObservations(rows)) {
    const found = classifyAbsence(observation, labels);
    if ('member' in found) counts[found.member] = (counts[found.member] ?? 0) + 1;
  }
  return counts;
}
