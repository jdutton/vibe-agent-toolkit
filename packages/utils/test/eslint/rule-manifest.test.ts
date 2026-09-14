/**
 * The rule manifest IS the `eslint/rules/` directory, and everything derived
 * from it — `rules`, `configs.recommended` — is asserted
 * against the directory rather than against a number.
 *
 * The old form pinned `toHaveLength(27)`, `19`, `15`, `4` beside a prose comment
 * carrying the same four numbers. Every one of those had been wrong at least
 * once ("18 of the 22 rules, four are excluded" while the registry held 24 and
 * the exclude set six). A count is a claim about the manifest that the manifest
 * cannot check; a set derived from the manifest is the manifest.
 */

import { readdirSync } from 'node:fs';

import type { Rule } from 'eslint';
import { describe, expect, it } from 'vitest';

import { resolveFromImportMeta } from '../../src/fs.js';

import { loadEslintModule, loadLocalRuleModule } from './rule-tester.js';

const RULES_DIR = resolveFromImportMeta(import.meta.url, '..', '..', 'eslint', 'rules');
const NAMESPACE = '@vibe-agent-toolkit/';

interface Plugin {
  rules: Record<string, Rule.RuleModule & { meta: { docs: { recommended: boolean; recommendedSeverity?: 'error' | 'warn' } } }>;
  configs: { recommended: { rules: Record<string, 'error' | 'warn'> } };
}

const plugin = loadEslintModule<Plugin>('index.cjs');
const byName = (a: string, b: string): number => a.localeCompare(b);

/** Every `.cjs` under `rules/` that exports a `meta` — the manifest, read independently of `index.cjs`. */
function rulesOnDisk(): string[] {
  return readdirSync(RULES_DIR)
    .filter((file) => file.endsWith('.cjs'))
    .filter((file) => {
      const candidate = loadLocalRuleModule<{ meta?: unknown }>(file);
      return typeof candidate.meta === 'object' && candidate.meta !== null;
    })
    .map((file) => file.slice(0, -'.cjs'.length))
    .sort(byName);
}

describe('rules are discovered from the directory', () => {
  it('registers exactly the modules that export a meta, keyed by basename', () => {
    expect(Object.keys(plugin.rules).sort(byName)).toStrictEqual(rulesOnDisk());
  });

  it('registers no factory or helper as a rule', () => {
    for (const helper of ['eslint-rule-factory', 'no-command-direct-factory', 'exempt-path-matcher', 'safe-import', 'dead-import']) {
      expect(plugin.rules).not.toHaveProperty(helper);
    }
  });

  it('discovers a non-trivial pack', () => {
    // A directory that read as empty would make every set assertion here pass
    // on two empty sets. The floor is deliberately far below the real count.
    expect(Object.keys(plugin.rules).length).toBeGreaterThan(10);
  });
});

describe('every rule carries a complete manifest entry', () => {
  it.each(Object.entries(plugin.rules))('%s', (_name, rule) => {
    const { docs } = rule.meta;
    expect(['problem', 'suggestion', 'layout']).toContain(rule.meta.type);
    expect(typeof docs.description).toBe('string');
    expect(docs.description.length).toBeGreaterThan(0);
    expect(typeof docs.recommended).toBe('boolean');
    if (docs.recommended) {
      expect(['error', 'warn']).toContain(docs.recommendedSeverity);
    }
    // A schema is what makes a typo'd option a loud config error rather than a
    // silently ignored one; every rule in the pack declares one, even if empty.
    expect(rule.meta.schema).toBeDefined();
  });
});

describe('configs.recommended is derived from meta.docs', () => {
  const recommended = plugin.configs.recommended.rules;

  it('enables exactly the rules that declare recommended: true, under the namespace', () => {
    const declared = Object.entries(plugin.rules)
      .filter(([, rule]) => rule.meta.docs.recommended)
      .map(([name]) => `${NAMESPACE}${name}`)
      .sort(byName);
    expect(Object.keys(recommended).sort(byName)).toStrictEqual(declared);
  });

  it('assigns each the severity it declares', () => {
    for (const [id, severity] of Object.entries(recommended)) {
      const rule = plugin.rules[id.slice(NAMESPACE.length)];
      expect(severity).toBe(rule?.meta.docs.recommendedSeverity);
    }
  });

  it('uses both severities, so the split is real and not an artifact of one being unused', () => {
    expect(new Set(Object.values(recommended))).toStrictEqual(new Set(['error', 'warn']));
  });
});

