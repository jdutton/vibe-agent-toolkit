/**
 * Unit tests for import-marketplace.ts mapping primitives.
 *
 * The end-to-end importer is exercised by running the script against the
 * live upstream marketplaces during slice 1b development; these tests
 * pin down the pure-function building blocks so future refactors stay safe.
 */
import { describe, expect, it } from 'vitest';

import {
  CATALOG_KNOWLEDGE_WORK,
  CATALOG_OFFICIAL,
  assertCatalogNonEmpty,
  assertNoCatastrophicShrinkage,
  combineAndDedupe,
  composeSourceUrl,
  deriveConfidence,
  mapEntry,
  mungeName,
  parseRunArgs,
  partitionPreserved,
  type UpstreamEntry,
} from '../src/import-marketplace.js';

// Small factory to keep individual tests focused on the inputs that matter.
function upstream(name: string, source: UpstreamEntry['source']): UpstreamEntry {
  return { name, source };
}

// Literals referenced by 3+ tests, pulled out to satisfy sonarjs/no-duplicate-string.
const SKILL_CREATOR = 'skill-creator';
const GIT_SUBDIR = 'git-subdir';
const FIRST_PARTY = 'first-party';
const EXAMPLE_FOO_URL = 'https://github.com/example/foo.git';

describe('mungeName', () => {
  it('leaves a valid name unchanged', () => {
    expect(mungeName(SKILL_CREATOR)).toEqual(SKILL_CREATOR);
  });

  it('replaces a dot with a dash', () => {
    expect(mungeName('wordpress.com')).toEqual('wordpress-com');
  });

  it('collapses a run of invalid characters into a single dash', () => {
    expect(mungeName('foo!!bar')).toEqual('foo-bar');
  });
});

describe('composeSourceUrl', () => {
  it('handles string source by combining with catalog clone URL and ref', () => {
    const entry = upstream(SKILL_CREATOR, `./plugins/${SKILL_CREATOR}`);
    expect(composeSourceUrl(entry, CATALOG_OFFICIAL)).toEqual(
      `https://github.com/anthropics/claude-plugins-official.git#main:plugins/${SKILL_CREATOR}`,
    );
  });

  it('handles git-subdir with ref + path', () => {
    const entry = upstream('api-security-testing', {
      source: GIT_SUBDIR,
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
      ref: 'v1.5.5',
      sha: 'deadbeef',
    });
    expect(composeSourceUrl(entry, CATALOG_OFFICIAL)).toEqual(
      'https://github.com/42Crunch-AI/claude-plugins.git#v1.5.5:plugins/api-security-testing',
    );
  });

  it('handles git-subdir without ref (default-branch fallback)', () => {
    const entry = upstream('semgrep', {
      source: GIT_SUBDIR,
      url: 'https://github.com/semgrep/mcp-marketplace.git',
      path: 'plugin',
      sha: 'deadbeef',
    });
    expect(composeSourceUrl(entry, CATALOG_OFFICIAL)).toEqual(
      'https://github.com/semgrep/mcp-marketplace.git#:plugin',
    );
  });

  it('handles url shape with path (omits ref)', () => {
    const entry = upstream('atomic-agents', {
      source: 'url',
      url: 'https://github.com/BrainBlend-AI/atomic-agents.git',
      path: 'claude-plugin/atomic-agents',
      sha: 'deadbeef',
    });
    expect(composeSourceUrl(entry, CATALOG_OFFICIAL)).toEqual(
      'https://github.com/BrainBlend-AI/atomic-agents.git#:claude-plugin/atomic-agents',
    );
  });

  it('handles url shape without path (just the clone URL)', () => {
    const entry = upstream('agentforce-adlc', {
      source: 'url',
      url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
      sha: 'deadbeef',
    });
    expect(composeSourceUrl(entry, CATALOG_OFFICIAL)).toEqual(
      'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
    );
  });

  it('handles github shape by composing https URL from repo field', () => {
    const entry = upstream('fullstory', {
      source: 'github',
      repo: 'fullstorydev/fullstory-skills',
      commit: 'abc123',
      sha: 'deadbeef',
    });
    expect(composeSourceUrl(entry, CATALOG_OFFICIAL)).toEqual(
      'https://github.com/fullstorydev/fullstory-skills.git',
    );
  });

  it('throws on an unknown source discriminator', () => {
    const entry = upstream('weird', {
      source: 'unknown-shape',
    });
    expect(() => composeSourceUrl(entry, CATALOG_OFFICIAL)).toThrow(/unknown source discriminator/);
  });
});

describe('deriveConfidence', () => {
  it('returns first-party for a string source not under partner-built', () => {
    expect(deriveConfidence(upstream('data', './data'))).toEqual(FIRST_PARTY);
  });

  it('returns curated for a string source under partner-built', () => {
    expect(deriveConfidence(upstream('zoom', './partner-built/zoom-plugin'))).toEqual('curated');
  });

  it('returns first-party for an object source on a github.com/anthropics URL', () => {
    const entry = upstream('something', {
      source: GIT_SUBDIR,
      url: 'https://github.com/anthropics/some-other-repo.git',
      path: 'plugins/x',
      ref: 'main',
    });
    expect(deriveConfidence(entry)).toEqual(FIRST_PARTY);
  });

  it('returns curated for an object source on a non-anthropics URL', () => {
    const entry = upstream('lusha', {
      source: 'url',
      url: 'https://github.com/lusha-oss/lusha-mcp-plugin.git',
      sha: 'deadbeef',
    });
    expect(deriveConfidence(entry)).toEqual('curated');
  });

  it('returns curated for a github-shape source whose repo is not under anthropics', () => {
    const entry = upstream('fullstory', {
      source: 'github',
      repo: 'fullstorydev/fullstory-skills',
      commit: 'abc',
    });
    expect(deriveConfidence(entry)).toEqual('curated');
  });
});

describe('mapEntry', () => {
  it('applies the knowledge-work prefix to entries from the knowledge-work catalog', () => {
    const entry = upstream('data', './data');
    expect(mapEntry(entry, CATALOG_KNOWLEDGE_WORK)).toEqual({
      source: 'https://github.com/anthropics/knowledge-work-plugins.git#main:data',
      name: 'knowledge-work-data',
      bucket: 'official',
      confidence: FIRST_PARTY,
      maturity: 'production',
    });
  });

  it('munges a name with a dot through to the final PluginEntry', () => {
    const entry = upstream('wordpress.com', {
      source: 'url',
      url: 'https://github.com/Automattic/claude-code-wordpress.com.git',
      sha: 'deadbeef',
    });
    expect(mapEntry(entry, CATALOG_OFFICIAL).name).toEqual('wordpress-com');
  });
});

describe('combineAndDedupe', () => {
  const officialA: ReturnType<typeof mapEntry> = {
    source: EXAMPLE_FOO_URL,
    name: 'a-foo',
    bucket: 'official',
    confidence: 'curated',
    maturity: 'production',
  };
  const officialB: ReturnType<typeof mapEntry> = {
    source: EXAMPLE_FOO_URL, // same source as officialA
    name: 'b-foo',
    bucket: 'official',
    confidence: 'curated',
    maturity: 'production',
  };
  const officialC: ReturnType<typeof mapEntry> = {
    source: 'https://github.com/example/bar.git',
    name: 'c-bar',
    bucket: 'official',
    confidence: 'curated',
    maturity: 'production',
  };
  const kwA: ReturnType<typeof mapEntry> = {
    source: EXAMPLE_FOO_URL, // collides with official
    name: 'knowledge-work-foo',
    bucket: 'official',
    confidence: 'curated',
    maturity: 'production',
  };
  const preservedX: ReturnType<typeof mapEntry> = {
    source: 'https://github.com/example/preserved.git',
    name: 'x-preserved',
    bucket: 'official',
    confidence: 'first-party',
    maturity: 'production',
  };

  it('keeps the first occurrence per source URL and reports dropped names', () => {
    const result = combineAndDedupe([], [officialA, officialB, officialC], []);
    expect(result.officialKept).toEqual(2);
    expect(result.kwKept).toEqual(0);
    expect(result.droppedNames).toEqual(['b-foo']);
    expect(result.final.map(e => e.name)).toContain('a-foo');
    expect(result.final.map(e => e.name)).not.toContain('b-foo');
  });

  it('prefers an official entry over a knowledge-work entry for the same source URL', () => {
    const result = combineAndDedupe([], [officialA], [kwA]);
    expect(result.officialKept).toEqual(1);
    expect(result.kwKept).toEqual(0);
    expect(result.droppedNames).toEqual(['knowledge-work-foo']);
  });

  it('emits preserved entries first, in input order', () => {
    const result = combineAndDedupe([preservedX], [officialC], []);
    expect(result.final.map(e => e.name)).toEqual(['x-preserved', 'c-bar']);
  });

  it('preserved entries win over imports with the same source URL', () => {
    const preservedCollidingWithA: ReturnType<typeof mapEntry> = {
      source: EXAMPLE_FOO_URL,
      name: 'preserved-foo',
      bucket: 'official',
      confidence: FIRST_PARTY,
      maturity: 'production',
    };
    const result = combineAndDedupe([preservedCollidingWithA], [officialA], []);
    expect(result.officialKept).toEqual(0);
    expect(result.droppedNames).toEqual(['a-foo']);
    expect(result.final.map(e => e.name)).toEqual(['preserved-foo']);
  });

  it('handles empty inputs without error', () => {
    const result = combineAndDedupe([], [], []);
    expect(result.final).toEqual([]);
    expect(result.droppedNames).toEqual([]);
    expect(result.officialKept).toEqual(0);
    expect(result.kwKept).toEqual(0);
  });
});

describe('partitionPreserved', () => {
  const baseExisting = [
    {
      source: 'https://github.com/jdutton/vibe-validate.git#claude-marketplace',
      name: 'vibe-validate',
      bucket: 'official' as const,
      confidence: FIRST_PARTY as 'first-party',
      maturity: 'production' as const,
    },
    {
      source: 'https://github.com/anthropics/claude-plugins-official.git#main:plugins/skill-creator',
      name: SKILL_CREATOR,
      bucket: 'official' as const,
      confidence: FIRST_PARTY as 'first-party',
      maturity: 'production' as const,
    },
  ];

  it('keeps entries whose source is not in the imported set', () => {
    const imported = new Set([
      'https://github.com/anthropics/claude-plugins-official.git#main:plugins/skill-creator',
    ]);
    const preserved = partitionPreserved(baseExisting, imported);
    expect(preserved.map(e => e.name)).toEqual(['vibe-validate']);
  });

  it('returns empty when every existing source is also imported', () => {
    const imported = new Set(baseExisting.map(e => e.source));
    expect(partitionPreserved(baseExisting, imported)).toEqual([]);
  });

  it('throws if a preserved entry carries a validation block', () => {
    const [firstEntry] = baseExisting;
    if (firstEntry === undefined) throw new Error('test setup invariant: baseExisting must be non-empty');
    const withValidation = [
      { ...firstEntry, validation: { severity: { SOME_CODE: 'ignore' } } },
    ];
    expect(() => partitionPreserved(withValidation, new Set<string>())).toThrow(/validation block/);
  });
});

describe('assertCatalogNonEmpty', () => {
  it('throws when a catalog returned 0 plugins and allowShrink is false', () => {
    expect(() => assertCatalogNonEmpty(CATALOG_OFFICIAL, 0, false)).toThrow(
      /returned 0 plugins/,
    );
  });

  it('does not throw when a catalog returned 0 plugins but allowShrink is true', () => {
    expect(() => assertCatalogNonEmpty(CATALOG_OFFICIAL, 0, true)).not.toThrow();
  });

  it('does not throw when a catalog returned any plugins', () => {
    expect(() => assertCatalogNonEmpty(CATALOG_OFFICIAL, 1, false)).not.toThrow();
    expect(() => assertCatalogNonEmpty(CATALOG_OFFICIAL, 200, false)).not.toThrow();
  });
});

describe('assertNoCatastrophicShrinkage', () => {
  it('throws when the new count drops by more than 20% vs. existing', () => {
    // 238 → 32 is ~87% drop, the silent-data-loss scenario.
    expect(() => assertNoCatastrophicShrinkage(238, 32, false)).toThrow(
      /Refusing to shrink seed\.yaml/,
    );
  });

  it('allows a drop of exactly 20% (the threshold itself)', () => {
    // 100 → 80 is exactly 20% — must not trip the >20% guard.
    expect(() => assertNoCatastrophicShrinkage(100, 80, false)).not.toThrow();
  });

  it('throws on a drop fractionally above 20%', () => {
    // 100 → 79 is 21% — should trip.
    expect(() => assertNoCatastrophicShrinkage(100, 79, false)).toThrow(
      /Refusing to shrink seed\.yaml/,
    );
  });

  it('does not throw on growth or no change', () => {
    expect(() => assertNoCatastrophicShrinkage(100, 100, false)).not.toThrow();
    expect(() => assertNoCatastrophicShrinkage(100, 250, false)).not.toThrow();
  });

  it('bypasses with allowShrink=true even for catastrophic drops', () => {
    expect(() => assertNoCatastrophicShrinkage(238, 0, true)).not.toThrow();
  });

  it('treats an existing count of 0 as bootstrap (always allowed)', () => {
    expect(() => assertNoCatastrophicShrinkage(0, 0, false)).not.toThrow();
    expect(() => assertNoCatastrophicShrinkage(0, 50, false)).not.toThrow();
  });

  it('includes the actual counts in the error message for triage', () => {
    expect(() => assertNoCatastrophicShrinkage(238, 32, false)).toThrow(/238/);
    expect(() => assertNoCatastrophicShrinkage(238, 32, false)).toThrow(/32/);
  });
});

describe('parseRunArgs', () => {
  it('defaults allowShrink to false when --allow-shrink is absent', () => {
    expect(parseRunArgs([])).toEqual({ allowShrink: false });
    expect(parseRunArgs(['--verbose'])).toEqual({ allowShrink: false });
  });

  it('sets allowShrink to true when --allow-shrink is present', () => {
    expect(parseRunArgs(['--allow-shrink'])).toEqual({ allowShrink: true });
    expect(parseRunArgs(['--other', '--allow-shrink'])).toEqual({ allowShrink: true });
  });
});
