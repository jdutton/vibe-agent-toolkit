/**
 * Pure function: render JoinedMatrixRow[] + RunMetadata into the markdown
 * report skeleton. The output is the matrix + methodology backbone; named
 * findings, failure-mode commentary, and detector-improvement proposals are
 * authored by a human on top of this rendered base.
 */

import type {
  Agreement,
  Bucket,
  JoinedMatrixRow,
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

function observedCell(row: JoinedMatrixRow): string {
  const det = row.observedDeterministic;
  return row.observedJudge === undefined ? det : `${det} / ${row.observedJudge}`;
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

interface HeadlineStats {
  totalCells: number;
  agree: number;
  vatPessimistic: number;
  vatOptimistic: number;
  ambiguous: number;
  agreementPct: string;
}

function computeHeadlineStats(rows: readonly JoinedMatrixRow[]): HeadlineStats {
  const counts = { agree: 0, 'vat-pessimistic': 0, 'vat-optimistic': 0, ambiguous: 0 };
  for (const r of rows) counts[r.agreement]++;
  const total = rows.length;
  const pct = total === 0 ? '0.0' : ((counts.agree / total) * 100).toFixed(1);
  return {
    totalCells: total,
    agree: counts.agree,
    vatPessimistic: counts['vat-pessimistic'],
    vatOptimistic: counts['vat-optimistic'],
    ambiguous: counts.ambiguous,
    agreementPct: pct,
  };
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
  const stats = computeHeadlineStats(rows);

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

Across **${stats.totalCells} (skill × runtime) cells**, VAT's static prediction
agreed with observed runtime behavior in **${stats.agree} cases (${stats.agreementPct}%)**.
The harness saw **${stats.vatOptimistic} VAT-optimistic** cells (predicted expected, runtime failed),
**${stats.vatPessimistic} VAT-pessimistic** cells (predicted incompatible/needs-review, runtime succeeded),
and **${stats.ambiguous} ambiguous** cells (mixed deterministic/judge signals).

This sample is exploratory, not statistically powered. Findings here justify
detector improvements proposed in a follow-up PR, scoped per the
\`docs/validation-rule-design.md\` rule-addition bar.

## Methodology

- **Runtimes covered:** ${meta.runtimesCovered.join(', ')}
- **Sample size:** ${meta.totalEntries} skills (own + official named in findings; community aggregated)
- **VAT version:** ${meta.vatVersion}
- **Judge model:** ${meta.judgeModel} (temperature 0)
- **Judge system-prompt SHA:** ${meta.judgePromptSha}
- **Trigger-prompts SHA:** ${meta.triggerPromptsSha}
- **Manifest SHA:** ${meta.manifestSha}
- **Run date:** ${meta.runDate}
- **Driver modes observed:**
${driverModeNote}

"Completion" is judged two ways per cell, both stored: a deterministic
presence-check (invocation detected? non-empty output? exit status?) and an
LLM judge (Sonnet 4.6, temperature 0). Cells where the two disagree are
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
