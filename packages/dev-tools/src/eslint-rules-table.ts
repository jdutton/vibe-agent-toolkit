/**
 * The `eslint-rules` generated block: the rule table of the
 * `@vibe-agent-toolkit/utils/eslint` pack, rendered from each rule's
 * `meta.docs`. One generator, one document (`packages/utils/eslint/README.md`,
 * the file that ships with the pack) — registered in `generate-claude-md.ts`
 * beside every other derived list, so `validate-structure` reds when the
 * committed table drifts from the rules and nothing else parses the markers.
 */

import { createRequire } from 'node:module';

import { safePath } from '@vibe-agent-toolkit/utils';

export interface RuleDocs {
  readonly description: string;
  readonly category?: string;
  readonly bans?: string;
  readonly useInstead?: string;
  readonly subpath?: string;
  readonly recommended: boolean;
  readonly recommendedSeverity?: 'error' | 'warn';
}

export interface RuleLike {
  readonly meta: { readonly docs: RuleDocs; readonly fixable?: string | null };
}

export interface PluginLike {
  readonly rules: Record<string, RuleLike>;
}

const CATEGORY_ORDER = [
  'Path handling',
  'Filesystem and process',
  'URLs and dynamic imports',
  'Entrypoint guards',
  'Process control',
  'Error handling',
  'Content decoding',
  'Build correctness',
  'Code and test hygiene',
];

const UNCATEGORISED = 'Other';

const TABLE_HEADER = ['| Rule | Bans | Use instead | Subpath | Fix | `recommended` |', '|---|---|---|---|---|---|'];

function categoryRank(category: string): [number, string] {
  const index = CATEGORY_ORDER.indexOf(category);
  return [index === -1 ? CATEGORY_ORDER.length : index, category];
}

function compareCategories(a: string, b: string): number {
  const [rankA, nameA] = categoryRank(a);
  const [rankB, nameB] = categoryRank(b);
  return rankA - rankB || nameA.localeCompare(nameB);
}

function row(name: string, rule: RuleLike): string {
  const { docs } = rule.meta;
  const subpath = docs.subpath ? `\`${docs.subpath}\`` : '—';
  const fix = rule.meta.fixable ? '✓' : '';
  const recommended = docs.recommended && docs.recommendedSeverity ? `\`${docs.recommendedSeverity}\`` : '—';
  return `| \`${name}\` | ${docs.bans ?? docs.description} | ${docs.useInstead ?? '—'} | ${subpath} | ${fix} | ${recommended} |`;
}

/** The block's lines (no markers): a summary line, then one table per category. */
export function renderEslintRulesTable(plugin: PluginLike): string[] {
  const entries = Object.entries(plugin.rules);
  const byCategory = new Map<string, [string, RuleLike][]>();
  for (const entry of entries) {
    const category = entry[1].meta.docs.category ?? UNCATEGORISED;
    const bucket = byCategory.get(category) ?? [];
    bucket.push(entry);
    byCategory.set(category, bucket);
  }

  const recommended = entries.filter(([, rule]) => rule.meta.docs.recommended);
  const errors = recommended.filter(([, rule]) => rule.meta.docs.recommendedSeverity === 'error').length;
  const warns = recommended.length - errors;
  const fixable = entries.filter(([, rule]) => rule.meta.fixable).length;

  const lines = [
    `${entries.length} rules; ${fixable} auto-fix. \`configs.recommended\` enables ${recommended.length} of them ` +
      `(${errors} at \`error\`, ${warns} at \`warn\`); \`—\` in the last column means the rule ships but must be enabled by name.`,
    '',
  ];
  for (const category of [...byCategory.keys()].sort(compareCategories)) {
    const rules = byCategory.get(category) ?? [];
    lines.push(`#### ${category}`, '', ...TABLE_HEADER);
    for (const [name, rule] of rules.toSorted(([a], [b]) => a.localeCompare(b))) {
      lines.push(row(name, rule));
    }
    lines.push('');
  }
  lines.pop(); // the generator frames the block; no trailing blank inside it
  return lines;
}

/** The rule pack as ESLint loads it, from the tree at `repoRoot`. */
export function loadRulePack(repoRoot: string): PluginLike {
  const requireFromRoot = createRequire(safePath.join(repoRoot, 'package.json'));
  return requireFromRoot('./packages/utils/eslint/index.cjs') as PluginLike;
}

/** The `eslint-rules` block for the tree at `repoRoot`. */
export function eslintRulesTable(repoRoot: string): string[] {
  return renderEslintRulesTable(loadRulePack(repoRoot));
}
