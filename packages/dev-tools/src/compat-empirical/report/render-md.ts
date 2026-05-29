/**
 * Pure function: render JoinedMatrixRow[] + RunMetadata into the markdown
 * report skeleton. The output is the matrix + methodology backbone; named
 * findings, failure-mode commentary, and detector-improvement proposals are
 * authored by a human on top of this rendered base.
 */

import type {
  Agreement,
  AttemptStats,
  Bucket,
  DeterministicClass,
  JoinedMatrixRow,
  JudgeVerdict,
  RunMetadata,
  Target,
} from '../types.js';

const TARGETS_IN_ORDER: readonly Target[] = ['claude-code', 'claude-cowork', 'claude-chat'];

const TARGET_HEADERS: Readonly<Record<Target, string>> = {
  'claude-code': 'Code',
  'claude-cowork': 'Cowork',
  'claude-chat': 'Chat',
};

const AGREEMENT_BADGES: Readonly<Record<Agreement, string>> = {
  agree: '✓',
  'vat-pessimistic': '⚠ pessimistic',
  'vat-optimistic': '⚠ optimistic',
  ambiguous: '?',
};

/**
 * Gray-zone pattern names (design §3). A row may match at most one pattern.
 * Pattern classification is orthogonal to the agreement label — a row can
 * be `vat-optimistic` AND carry e.g. a `not-invoked-engaged` pattern; the
 * gray-zone section surfaces the pattern signal independently.
 */
type GrayZonePattern = 'judge-softer-than-det' | 'invoked-but-empty' | 'not-invoked-engaged';

const PATTERN_JUDGE_SOFTER: GrayZonePattern = 'judge-softer-than-det';
const PATTERN_INVOKED_EMPTY: GrayZonePattern = 'invoked-but-empty';
const PATTERN_NOT_INVOKED_ENGAGED: GrayZonePattern = 'not-invoked-engaged';

const DET_INVOKED_OUTPUT: DeterministicClass = 'invoked-output';

const GRAY_ZONE_PATTERN_ORDER: readonly GrayZonePattern[] = [
  PATTERN_JUDGE_SOFTER,
  PATTERN_INVOKED_EMPTY,
  PATTERN_NOT_INVOKED_ENGAGED,
];

const GRAY_ZONE_PATTERN_DESCRIPTIONS: Readonly<Record<GrayZonePattern, string>> = {
  [PATTERN_JUDGE_SOFTER]:
    'det says skill produced output but the judge graded it partial or failed',
  [PATTERN_INVOKED_EMPTY]:
    'invocation detected in transcript but the output text was empty',
  [PATTERN_NOT_INVOKED_ENGAGED]:
    'agent produced output but never picked the skill — possible DESCRIPTION_TOO_VAGUE signal',
};

function classifyGrayZonePattern(row: JoinedMatrixRow): GrayZonePattern | undefined {
  if (
    row.observedDeterministic === DET_INVOKED_OUTPUT &&
    (row.observedJudge === 'partial' || row.observedJudge === 'failed')
  ) {
    return PATTERN_JUDGE_SOFTER;
  }
  if (row.observedDeterministic === 'invoked-no-output') {
    return PATTERN_INVOKED_EMPTY;
  }
  // The deterministic class and the gray-zone pattern happen to share the
  // name `not-invoked-engaged` — they are different domain enums that
  // coincide here.
  if (row.observedDeterministic === 'not-invoked-engaged') {
    return PATTERN_NOT_INVOKED_ENGAGED;
  }
  return undefined;
}

function formatVarianceFraction(count: number, total: number): string {
  return `(${count}/${total})`;
}

function detCount(stats: AttemptStats, cls: DeterministicClass): number {
  return stats.byDeterministicClass[cls] ?? 0;
}

function judgeCount(stats: AttemptStats, verdict: JudgeVerdict): number {
  return stats.byJudgeVerdict[verdict] ?? 0;
}

/**
 * Observed-cell text. When `attemptStats.n === 1` the cell renders as the
 * v1 shape (`det / judge`) for parity with single-shot runs. When `n > 1`
 * we surface per-attempt counts inline: `runtime-error (2/3) / failed (3/3)`,
 * so a reader can see how concentrated each signal is without clicking
 * through to per-cell artifacts (design §3 "Per-attempt variance").
 */
function observedCell(row: JoinedMatrixRow): string {
  const det = row.observedDeterministic;
  const judge = row.observedJudge;
  const n = row.attemptStats.n;

  if (n <= 1) {
    return judge === undefined ? det : `${det} / ${judge}`;
  }

  const detText = `${det} ${formatVarianceFraction(detCount(row.attemptStats, det), n)}`;
  if (judge === undefined) return detText;
  return `${detText} / ${judge} ${formatVarianceFraction(judgeCount(row.attemptStats, judge), n)}`;
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function groupBySkillId(rows: JoinedMatrixRow[]): Map<string, JoinedMatrixRow[]> {
  const bySkill = new Map<string, JoinedMatrixRow[]>();
  for (const r of rows) {
    const list = bySkill.get(r.skillId) ?? [];
    list.push(r);
    bySkill.set(r.skillId, list);
  }
  return bySkill;
}

function buildNamedTable(rows: JoinedMatrixRow[]): string {
  const bySkill = groupBySkillId(rows);
  const skillIds = [...bySkill.keys()].sort(compareStrings);

  const lines: string[] = [
    '| skill | target | predicted | observed (det / judge) | agreement |',
    '|---|---|---|---|---|',
  ];

  for (const skillId of skillIds) {
    const byTarget = new Map<Target, JoinedMatrixRow>();
    for (const r of bySkill.get(skillId) ?? []) byTarget.set(r.target, r);
    for (const target of TARGETS_IN_ORDER) {
      const r = byTarget.get(target);
      if (!r) continue;
      lines.push(
        `| \`${skillId}\` | ${TARGET_HEADERS[target]} | ${r.predicted} | ${observedCell(r)} | ${AGREEMENT_BADGES[r.agreement]} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function buildAggregateTable(rows: JoinedMatrixRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.target}|${r.predicted}|${r.observedDeterministic}|${r.observedJudge ?? '-'}|${r.agreement}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const lines: string[] = [
    '| target | predicted | observed (det / judge) | agreement | count |',
    '|---|---|---|---|---|',
  ];

  const sortedKeys = [...counts.keys()].sort(compareStrings);
  for (const k of sortedKeys) {
    const parts = k.split('|');
    const target = (parts[0] ?? '') as Target;
    const predicted = parts[1] ?? '';
    const det = parts[2] ?? '';
    const judge = parts[3] ?? '-';
    const agreement = (parts[4] ?? 'ambiguous') as Agreement;
    const observed = judge === '-' ? det : `${det} / ${judge}`;
    lines.push(
      `| ${TARGET_HEADERS[target]} | ${predicted} | ${observed} | ${AGREEMENT_BADGES[agreement]} | ${counts.get(k) ?? 0} |`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function renderBucketTable(bucket: Bucket, rows: JoinedMatrixRow[], anonymize: boolean): string {
  if (rows.length === 0) {
    return `_No entries in the ${bucket} bucket._\n`;
  }
  return anonymize ? buildAggregateTable(rows) : buildNamedTable(rows);
}

interface CoverageStats {
  totalPossible: number;
  ran: number;
  skipped: number;
  byRuntime: Map<Target, { ran: number; total: number }>;
}

function computeCoverage(rows: readonly JoinedMatrixRow[]): CoverageStats {
  const byRuntime = new Map<Target, { ran: number; total: number }>();
  for (const t of TARGETS_IN_ORDER) byRuntime.set(t, { ran: 0, total: 0 });

  let ran = 0;
  for (const r of rows) {
    const bucket = byRuntime.get(r.target);
    if (bucket) {
      bucket.total += 1;
      if (r.observedDeterministic !== 'skipped') bucket.ran += 1;
    }
    if (r.observedDeterministic !== 'skipped') ran += 1;
  }

  return {
    totalPossible: rows.length,
    ran,
    skipped: rows.length - ran,
    byRuntime,
  };
}

interface BucketHeadlineStats {
  ran: number;
  agree: number;
  vatOptimistic: number;
  vatPessimistic: number;
  grayZone: number;
}

/**
 * Per-bucket headline counts (design §3 "Per-bucket headline numbers").
 * `grayZone` counts rows that match any gray-zone pattern — note this is
 * orthogonal to the `ambiguous` agreement label: a row can be vat-optimistic
 * AND match `not-invoked-engaged`, and we count it once in both columns.
 * Skipped rows contribute to neither ran nor any agreement/gray-zone count.
 */
function computeBucketStats(rows: readonly JoinedMatrixRow[]): BucketHeadlineStats {
  const stats: BucketHeadlineStats = { ran: 0, agree: 0, vatOptimistic: 0, vatPessimistic: 0, grayZone: 0 };
  for (const r of rows) {
    if (r.observedDeterministic === 'skipped') continue;
    stats.ran += 1;
    if (r.agreement === 'agree') stats.agree += 1;
    else if (r.agreement === 'vat-optimistic') stats.vatOptimistic += 1;
    else if (r.agreement === 'vat-pessimistic') stats.vatPessimistic += 1;
    if (classifyGrayZonePattern(r) !== undefined) stats.grayZone += 1;
  }
  return stats;
}

function percent(num: number, denom: number): string {
  if (denom === 0) return '0.0';
  return ((num / denom) * 100).toFixed(1);
}

function renderCoverageSentence(coverage: CoverageStats, agreeCount: number): string {
  const byRuntimeParts = TARGETS_IN_ORDER.map((t) => {
    const c = coverage.byRuntime.get(t) ?? { ran: 0, total: 0 };
    return `${TARGET_HEADERS[t]}: ${c.ran}/${c.total}`;
  }).join(', ');

  const agreePct = percent(agreeCount, coverage.ran);
  return (
    `Across **${coverage.ran}/${coverage.totalPossible} cells ran** (${byRuntimeParts}), ` +
    `VAT agreed with reality on **${agreeCount} cases (${agreePct}%)**.`
  );
}

function renderSkippedNote(coverage: CoverageStats): string {
  if (coverage.skipped === 0) return '';
  return (
    `\n*${coverage.skipped} cells were skipped — chat and cowork have ` +
    `human-in-the-loop drivers and the operator chose not to drive every cell. ` +
    `Agreement % is computed over ran cells only.*\n`
  );
}

const BUCKETS_IN_ORDER: readonly Bucket[] = ['own', 'official', 'community'];

function renderPerBucketHeadlineTable(rows: readonly JoinedMatrixRow[]): string {
  const lines: string[] = [
    '| bucket | ran | agree | optimistic | pessimistic | gray-zone |',
    '|---|---|---|---|---|---|',
  ];
  for (const bucket of BUCKETS_IN_ORDER) {
    const bucketRows = rows.filter((r) => r.bucket === bucket);
    const s = computeBucketStats(bucketRows);
    const agreeCell = s.ran === 0 ? '0' : `${s.agree} (${percent(s.agree, s.ran)}%)`;
    lines.push(
      `| ${bucket} | ${s.ran} | ${agreeCell} | ${s.vatOptimistic} | ${s.vatPessimistic} | ${s.grayZone} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function formatNamedRowSlug(row: JoinedMatrixRow): string {
  return `\`${row.bucket}:${row.skillId}\` / ${TARGET_HEADERS[row.target]}`;
}

function rowSortKey(r: JoinedMatrixRow): string {
  return `${r.bucket}:${r.skillId}:${r.target}`;
}

function sortNamedRows(rows: readonly JoinedMatrixRow[]): JoinedMatrixRow[] {
  return [...rows].sort((a, b) => compareStrings(rowSortKey(a), rowSortKey(b)));
}

function renderGrayZoneRowLine(r: JoinedMatrixRow): string {
  const judgePart = r.observedJudge ? `, judge=${r.observedJudge}` : '';
  return `- ${formatNamedRowSlug(r)}: det=${r.observedDeterministic}${judgePart}`;
}

/**
 * Build the standard "named cells listed by line + community count line"
 * body shared by the gray-zone and high-variance callout sections. Both
 * sections render named (own/official) cells inline and aggregate
 * community cells to a count-only line per the two-bucket discipline.
 */
function buildNamedPlusCommunityBody(
  rows: readonly JoinedMatrixRow[],
  renderNamedLine: (r: JoinedMatrixRow) => string,
): string {
  const named = rows.filter((r) => r.bucket !== 'community');
  const community = rows.filter((r) => r.bucket === 'community');
  const namedLines = sortNamedRows(named).map(renderNamedLine).join('\n');
  const communityLine = community.length === 0
    ? ''
    : `- community: ${community.length} cells (aggregated; not named)`;
  return [namedLines, communityLine].filter((s) => s.length > 0).join('\n');
}

function renderGrayZoneSubsection(pattern: GrayZonePattern, rows: JoinedMatrixRow[]): string {
  const header = `#### ${pattern} (${rows.length} cells)\n`;
  const description = `_${GRAY_ZONE_PATTERN_DESCRIPTIONS[pattern]}._\n`;
  const body = buildNamedPlusCommunityBody(rows, renderGrayZoneRowLine);
  return `${header}\n${description}\n${body || '_No cells._'}\n`;
}

function renderGrayZoneSection(rows: readonly JoinedMatrixRow[]): string {
  const byPattern = new Map<GrayZonePattern, JoinedMatrixRow[]>();
  for (const r of rows) {
    const p = classifyGrayZonePattern(r);
    if (!p) continue;
    const list = byPattern.get(p) ?? [];
    list.push(r);
    byPattern.set(p, list);
  }

  if (byPattern.size === 0) {
    return '\n### Gray-zone (mixed-signal) cells\n\n_No gray-zone cells in this run._\n';
  }

  const subsections = GRAY_ZONE_PATTERN_ORDER
    .map((p) => ({ p, rs: byPattern.get(p) }))
    .filter((x): x is { p: GrayZonePattern; rs: JoinedMatrixRow[] } => x.rs !== undefined && x.rs.length > 0)
    .map((x) => renderGrayZoneSubsection(x.p, x.rs))
    .join('\n');

  return (
    '\n### Gray-zone (mixed-signal) cells\n\n' +
    'Cells where deterministic and judge signals diverge, or where the deterministic\n' +
    'class itself is a gray-zone signal (invocation detected with no output; agent\n' +
    'engaged but didn\'t pick the skill). Grouped by pattern. Community-bucket cells\n' +
    'are aggregated as counts only, per the two-bucket discipline.\n\n' +
    subsections
  );
}

function renderHighVarianceRowLine(row: JoinedMatrixRow): string {
  const stats = row.attemptStats;
  const triggered =
    detCount(stats, DET_INVOKED_OUTPUT) + detCount(stats, 'invoked-no-output');
  const completed = detCount(stats, DET_INVOKED_OUTPUT);
  return (
    `- ${formatNamedRowSlug(row)}: trigger-rate ${triggered}/${stats.n}, ` +
    `completion ${completed}/${stats.n} — extended from N=3 to N=5, still ambiguous`
  );
}

function renderHighVarianceSection(rows: readonly JoinedMatrixRow[]): string {
  const flagged = rows.filter((r) => r.highVariance);
  if (flagged.length === 0) {
    return '\n### High-variance cells (N=5, still ambiguous)\n\n_No high-variance cells in this run._\n';
  }

  const body = buildNamedPlusCommunityBody(flagged, renderHighVarianceRowLine);

  return (
    '\n### High-variance cells (N=5, still ambiguous)\n\n' +
    'These cells were extended from N=3 to N=5 due to inconsistent first-3 attempts\n' +
    'and remained inconsistent at N=5. The variance itself is the finding — these\n' +
    'skill/runtime pairs trigger or complete unpredictably and probably warrant a\n' +
    'stability flag in the detector-improvement follow-up.\n\n' +
    `${body}\n`
  );
}

function renderDriverModeList(rows: readonly JoinedMatrixRow[]): string {
  const modes = new Set(rows.map((r) => `${r.target}:${r.driverMode}`));
  return [...modes].sort(compareStrings).map((m) => `- ${m}`).join('\n');
}

export interface RenderOptions {
  rows: readonly JoinedMatrixRow[];
  meta: RunMetadata;
}

export function renderReport(options: RenderOptions): string {
  const { rows, meta } = options;
  const coverage = computeCoverage(rows);
  const ranRows = rows.filter((r) => r.observedDeterministic !== 'skipped');

  const agreeCount = ranRows.filter((r) => r.agreement === 'agree').length;
  const vatOptimistic = ranRows.filter((r) => r.agreement === 'vat-optimistic').length;
  const vatPessimistic = ranRows.filter((r) => r.agreement === 'vat-pessimistic').length;
  const ambiguous = ranRows.filter((r) => r.agreement === 'ambiguous').length;

  const ownRows = rows.filter((r) => r.bucket === 'own');
  const officialRows = rows.filter((r) => r.bucket === 'official');
  const communityRows = rows.filter((r) => r.bucket === 'community');
  const driverModeNote = renderDriverModeList(rows);

  return `# [vat: empirical] Runtime Compatibility — Empirical Report

> Status: rendered scaffold. Headline numbers and matrices below are produced
> by the harness from \`packages/dev-tools/corpus/compat-empirical/runs/${meta.runDate.slice(0, 10)}/\`.
> The Failure-Mode Taxonomy and Detector-Improvement Proposals sections are
> authored on top of this rendered base.

## Executive summary

${renderCoverageSentence(coverage, agreeCount)}
The harness saw **${vatOptimistic} VAT-optimistic** cells (predicted expected, runtime failed),
**${vatPessimistic} VAT-pessimistic** cells (predicted incompatible/needs-review, runtime succeeded),
and **${ambiguous} ambiguous** cells (mixed deterministic/judge signals).
${renderSkippedNote(coverage)}
${renderPerBucketHeadlineTable(rows)}
This sample is exploratory, not statistically powered. Findings here justify
detector improvements proposed in a follow-up PR, scoped per the
\`docs/validation-rule-design.md\` rule-addition bar.

## Methodology

- **Runtimes covered:** ${meta.runtimesCovered.join(', ')}
- **Sample size:** ${meta.totalEntries} skills (own + official named in findings; community aggregated)
- **VAT version:** ${meta.vatVersion}
- **Judge model:** ${meta.judgeModel}
- **Auth mode:** ${meta.authMode} (judged via the subscription-authenticated \`claude\` CLI; no API billing)
- **Judge system-prompt SHA:** ${meta.judgePromptSha}
- **Trigger-prompts SHA:** ${meta.triggerPromptsSha}
- **Manifest SHA:** ${meta.manifestSha}
- **Run date:** ${meta.runDate}
- **Driver modes observed:**
${driverModeNote}

"Completion" is judged two ways per cell, both stored: a deterministic
presence-check (invocation detected? non-empty output? exit status?) and an
LLM judge run through the subscription \`claude\` CLI. The judge's structured
verdict is parsed from its JSON output (not tool-forced), validated strictly,
and retried once on a parse failure. Cells where the two signals disagree are
themselves findings; they get a callout below.

## Confusion matrices

### Own bucket (named)

${renderBucketTable('own', ownRows, false)}

### Official bucket (named)

${renderBucketTable('official', officialRows, false)}

### Community bucket (aggregated)

Per the two-bucket discipline named in \`docs/validation-rule-design.md\`,
community-bucket findings are reported as patterns and counts, not as named
skills.

${renderBucketTable('community', communityRows, true)}

## Callouts
${renderGrayZoneSection(rows)}
${renderHighVarianceSection(rows)}

## Failure-mode taxonomy

_(Authored by hand on top of this scaffold using the matrix above and the
per-skill transcript artifacts. Each named (skill, target) example is drawn
from the own or official bucket; community cells contribute aggregate counts
only.)_

## Detector-improvement proposals

_(Authored by hand. Each proposal must cite one or more matrix cells above
as evidence, per the rule-addition bar.)_

## Reproducibility

Re-run with:

\`\`\`bash
bun run -F @vibe-agent-toolkit/dev-tools compat-empirical all \\
  --manifest packages/dev-tools/corpus/compat-empirical/manifest.yaml \\
  --prompts packages/dev-tools/corpus/compat-empirical/trigger-prompts.yaml \\
  --out packages/dev-tools/corpus/compat-empirical/runs/<DATE>/
\`\`\`

Pinned: VAT version \`${meta.vatVersion}\`, judge model \`${meta.judgeModel}\`,
manifest SHA \`${meta.manifestSha}\`, prompts SHA \`${meta.triggerPromptsSha}\`.
`;
}
