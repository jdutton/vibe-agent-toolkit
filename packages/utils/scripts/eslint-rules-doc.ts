#!/usr/bin/env tsx
/**
 * The ONE rule table, generated from the rule pack's own `meta.docs`.
 *
 * `packages/utils/eslint/README.md` and `docs/custom-eslint-rules.md` each carry
 * a `<!-- gen:eslint-rules -->…<!-- /gen:eslint-rules -->` block; this script
 * rewrites both from `index.cjs`, and `test/eslint/rule-manifest.test.ts`
 * asserts the committed block equals the generated one. A rule added to
 * `eslint/rules/` therefore appears in both docs by running
 * `bun run generate:eslint-rules-doc` — and a rule whose row was edited by hand
 * fails the test until the metadata it came from is edited instead.
 *
 * The hand-written tables this replaces held 26 rows for 27 rules, and the
 * prose count beside them ("Twenty-seven rules") had been wrong three times.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { isEntrypoint } from '../src/entrypoint.js';
import { resolveFromImportMeta } from '../src/fs.js';

const requireFromHere = createRequire(import.meta.url);

/** The subset of a rule module this generator reads. */
export interface RuleDocs {
  description: string;
  category?: string;
  bans?: string;
  useInstead?: string;
  subpath?: string;
  recommended: boolean;
  recommendedSeverity?: 'error' | 'warn';
}

export interface RuleLike {
  meta: { docs: RuleDocs; fixable?: string | null };
}

export interface PluginLike {
  rules: Record<string, RuleLike>;
}

export const GEN_START = '<!-- gen:eslint-rules -->';
export const GEN_END = '<!-- /gen:eslint-rules -->';

/**
 * Category order for the table. Categories a rule declares that are not listed
 * here sort after these, alphabetically — a new rule with a new category is
 * still rendered, just at the end.
 */
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

/** Render the whole generated block, markers included. */
export function renderRulesDocBlock(plugin: PluginLike): string {
  const entries = Object.entries(plugin.rules);
  const byCategory = new Map<string, Array<[string, RuleLike]>>();
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
    GEN_START,
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
  lines.push(GEN_END);
  return lines.join('\n');
}

/** Replace the marked block in `markdown` with `block`; throws if the markers are missing. */
export function spliceRulesDocBlock(markdown: string, block: string): string {
  const start = markdown.indexOf(GEN_START);
  const end = markdown.indexOf(GEN_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`markdown carries no ${GEN_START} … ${GEN_END} block to replace`);
  }
  return markdown.slice(0, start) + block + markdown.slice(end + GEN_END.length);
}

/** The committed block, or `undefined` when a doc carries no markers. */
export function committedRulesDocBlock(markdown: string): string | undefined {
  const start = markdown.indexOf(GEN_START);
  const end = markdown.indexOf(GEN_END);
  if (start === -1 || end === -1 || end < start) {
    return undefined;
  }
  return markdown.slice(start, end + GEN_END.length);
}

/** The two documents that carry the block, repo-relative to this package. */
export const RULES_DOC_FILES = [
  resolveFromImportMeta(import.meta.url, '..', 'eslint', 'README.md'),
  resolveFromImportMeta(import.meta.url, '..', '..', '..', 'docs', 'custom-eslint-rules.md'),
];

export function loadRulePack(): PluginLike {
  return requireFromHere('../eslint/index.cjs') as PluginLike;
}

function main(): void {
  const block = renderRulesDocBlock(loadRulePack());
  for (const file of RULES_DOC_FILES) {
    // Our own committed doc, written by this repo as UTF-8: the encoding is not in question.
    const before = readFileSync(file, 'utf8');
    const after = spliceRulesDocBlock(before, block);
    if (after !== before) {
      writeFileSync(file, after, 'utf8');
      console.log(`updated ${file}`);
    }
  }
}

if (isEntrypoint(import.meta.url)) {
  main();
}
