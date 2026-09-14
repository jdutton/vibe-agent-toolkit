/**
 * The `eslint-rules` block renders one row per rule from `meta.docs`, grouped
 * by category in the documented order, with the summary line's counts derived
 * from the same entries. The fixture is three rules; the real-pack case pins
 * that every shipped rule appears exactly once.
 */

import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import { loadRulePack, renderEslintRulesTable, type PluginLike } from '../src/eslint-rules-table.js';

const FIXTURE: PluginLike = {
  rules: {
    'zeta-rule': { meta: { docs: { description: 'later category', category: 'Code and test hygiene', recommended: false } } },
    'no-raw-x': {
      meta: {
        docs: { description: 'd', category: 'Path handling', bans: '`x()`', useInstead: '`safeX()`', subpath: '/path', recommended: true, recommendedSeverity: 'error' },
        fixable: 'code',
      },
    },
    'alpha-rule': { meta: { docs: { description: 'uncategorised', recommended: true, recommendedSeverity: 'warn' } } },
  },
};

describe('renderEslintRulesTable', () => {
  const lines = renderEslintRulesTable(FIXTURE);

  it('summarises counts from the entries', () => {
    expect(lines[0]).toContain('3 rules; 1 auto-fix. `configs.recommended` enables 2 of them (1 at `error`, 1 at `warn`)');
  });

  it('orders categories by the documented rank, then the uncategorised bucket last', () => {
    const headings = lines.filter((line) => line.startsWith('#### '));
    expect(headings).toEqual(['#### Path handling', '#### Code and test hygiene', '#### Other']);
  });

  it('renders a row from bans/useInstead/subpath/fixable/severity, falling back to the description', () => {
    expect(lines).toContain('| `no-raw-x` | `x()` | `safeX()` | `/path` | ✓ | `error` |');
    expect(lines).toContain('| `alpha-rule` | uncategorised | — | — |  | `warn` |');
    expect(lines).toContain('| `zeta-rule` | later category | — | — |  | — |');
  });

  it('ends on the last table row, not a blank the block framing would double', () => {
    expect(lines.at(-1)).toMatch(/^\| `/);
  });
});

describe('the shipped rule pack', () => {
  it('lists every rule exactly once', () => {
    const plugin = loadRulePack(PROJECT_ROOT);
    const text = renderEslintRulesTable(plugin).join('\n');
    for (const name of Object.keys(plugin.rules)) {
      expect(text.split(`| \`${name}\` |`)).toHaveLength(2);
    }
  });
});
