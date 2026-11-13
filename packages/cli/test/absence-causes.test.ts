/**
 * The absence-cause enumeration, held both ways: against the static domain of
 * codes the packages export, and against its seeds.
 *
 * - Every code (and content state) in the static domain is classified exactly
 *   once, and nothing is classified that the domain does not hold.
 * - The seeded causes are the members: a member with no seed reds, and a seed
 *   naming anything else reds (test files are not typechecked, so the member
 *   type on a seed is documentation, and this is the check that fires).
 * - A system seed is skipped only on a host that lacks its declared need.
 *
 * What reads the seeds' source files (the seed-file templates, the lower-tier
 * finder and the call-site scan) runs in the integration tier:
 * `integration/absence-seed-sources.integration.test.ts`.
 */

import * as agentSkills from '@vibe-agent-toolkit/agent-skills';
import * as claudeMarketplace from '@vibe-agent-toolkit/claude-marketplace';
import * as resources from '@vibe-agent-toolkit/resources';
import { symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import {
  ABSENCE_EXEMPTIONS,
  ABSENCE_MEMBER_KEYS,
  CONTENT_STATE_KEYS,
  groupOf,
  memberEntry,
  memberRowCounts,
  siblingsOf,
  surfacedCodesOf,
} from './helpers/absence-causes.js';
import { causeOf, LOWER_TIER_SEEDS, namesPath, seedCases, SYSTEM_SEEDS, type SeedFileKey } from './helpers/absence-seeds.js';

/** Sorted, so a set compares as a list with a readable diff. */
function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/** Every string export of a barrel whose value is its own name: the barrel's exported codes. */
function selfNamedCodes(barrel: Record<string, unknown>): string[] {
  return Object.entries(barrel).filter(([name, value]) => value === name).map(([name]) => name);
}

/** The static domain: every code a row can carry that a package exports, and every content state. */
const STATIC_DOMAIN = sorted([
  ...resources.BLOB_REFUSAL_CONDITION_CODES,
  ...resources.BLOB_FINDING_CONDITION_CODES,
  ...CONTENT_STATE_KEYS,
  ...selfNamedCodes(resources),
  ...selfNamedCodes(claudeMarketplace),
  ...selfNamedCodes(agentSkills),
]);

describe('the enumeration covers the static domain', () => {
  it('classifies every code and content state exactly once: a member or an exemption, never both', () => {
    const exempt = Object.keys(ABSENCE_EXEMPTIONS);
    expect(exempt.filter((key) => (ABSENCE_MEMBER_KEYS as readonly string[]).includes(key))).toEqual([]);
    expect(sorted([...ABSENCE_MEMBER_KEYS, ...exempt])).toEqual(STATIC_DOMAIN);
  });

  it('reads the extent where new causes are likeliest: the filesystem extent\'s five codes are in the domain', () => {
    for (const code of [
      resources.EXTENT_DIRECTORY_UNLISTABLE,
      resources.EXTENT_SYMLINK_NOT_REALIZED,
      resources.EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
      resources.EXTENT_SYMLINK_TARGET_UNREADABLE,
      resources.EXTENT_SYMLINK_TARGET_UNRESOLVED,
    ]) {
      expect(STATIC_DOMAIN).toContain(code);
    }
  });

  it('keys each member by its own signature: the code, or contentState:<state>', () => {
    for (const member of ABSENCE_MEMBER_KEYS) {
      const { signature } = memberEntry(member);
      expect('contentState' in signature ? `contentState:${signature.contentState}` : signature.code).toBe(member);
    }
  });
});

describe('a declared refusal label is classified by provenance, never by value', () => {
  const FILESYSTEM = 'ctx-filesystem';
  const rows = {
    blobConditions: [],
    resourceRealizations: [],
    realizationConditions: [{ code: agentSkills.SKILL_REFUSED_GITIGNORED, extentId: FILESYSTEM, resourceId: null }],
    resolutionContexts: [{ contextId: FILESYSTEM, kind: 'filesystem' }],
  };

  it('throws on a refusal-label code its own extent did not declare', () => {
    expect(() => memberRowCounts(rows, new Map())).toThrow(/declared refusal label/);
  });

  it('throws when only another extent declared the label', () => {
    expect(() => memberRowCounts(rows, new Map([['ctx-skill', new Set([agentSkills.SKILL_REFUSED_GITIGNORED])]]))).toThrow(/declared refusal label/);
  });

  it('exempts it when its own extent declared the label', () => {
    expect(memberRowCounts(rows, new Map([[FILESYSTEM, new Set([agentSkills.SKILL_REFUSED_GITIGNORED])]]))).toEqual({});
  });
});

describe('surfaced codes, siblings and groups, asked of production', () => {
  it('surfaces a blob member through the not-admitted contract, and a condition member under its own code', () => {
    expect(surfacedCodesOf(resources.BLOB_PARSE_LIMIT_EXCEEDED)).toEqual(['RESOURCE_PARSE_LIMIT_EXCEEDED']);
    expect(surfacedCodesOf(resources.BLOB_UNREADABLE)).toEqual(['RESOURCE_UNREADABLE']);
    expect(surfacedCodesOf('contentState:oversize')).toEqual(['RESOURCE_PARSE_LIMIT_EXCEEDED', 'RESOURCE_UNREADABLE']);
    expect(surfacedCodesOf(resources.EXTENT_DIRECTORY_UNLISTABLE)).toEqual([resources.EXTENT_DIRECTORY_UNLISTABLE]);
  });

  it('surfaces a condition member under every code a built-in check reports for it too', () => {
    expect(surfacedCodesOf(resources.EXTENT_SYMLINK_NOT_REALIZED)).toEqual(['CLAUDE_RULE_LINK_UNCHECKED', resources.EXTENT_SYMLINK_NOT_REALIZED]);
  });

  it('derives the siblings a seed must show none of from overlapping surfaced codes', () => {
    expect(siblingsOf(resources.BLOB_PARSE_LIMIT_EXCEEDED)).toEqual(['contentState:oversize']);
    expect(siblingsOf(resources.EXTENT_SYMLINK_NOT_REALIZED)).toEqual([]);
    expect(siblingsOf('contentState:oversize')).toContain(resources.BLOB_PARSE_LIMIT_EXCEEDED);
    expect(siblingsOf('contentState:oversize')).toContain('contentState:unreadable');
  });

  it('puts every member a finding cannot tell apart in one group', () => {
    expect(groupOf(resources.BLOB_PARSE_LIMIT_EXCEEDED)).toBe(groupOf(resources.BLOB_UNREADABLE));
    expect(groupOf(resources.BLOB_PARSE_WORKER_DIED)).not.toBe(groupOf(resources.BLOB_PARSE_LIMIT_EXCEEDED));
    expect(groupOf(resources.EXTENT_DIRECTORY_UNLISTABLE)).toBe(resources.EXTENT_DIRECTORY_UNLISTABLE);
  });
});

describe('members and seeds, both ways', () => {
  const systemSeeds = Object.values(SYSTEM_SEEDS).flat();
  const systemCauses = systemSeeds.map((seed) => causeOf(seed));

  it('seeds every system-tier member with a system seed, and nothing else', () => {
    expect(systemCauses.filter((cause) => cause === undefined)).toEqual([]);
    expect(sorted(systemCauses as string[])).toEqual(sorted(ABSENCE_MEMBER_KEYS.filter((member) => memberEntry(member).tier === 'system')));
    expect(systemCauses).toHaveLength(new Set(systemCauses).size);
  });

  it('seeds every lower-tier member with a manifest row, and nothing else', () => {
    const lower = LOWER_TIER_SEEDS.map((seed) => seed.member);
    expect(sorted(lower)).toEqual(sorted(ABSENCE_MEMBER_KEYS.filter((member) => memberEntry(member).tier === 'lower')));
    expect(lower).toHaveLength(new Set(lower).size);
  });

  it('declares every system seed\'s host need, and skips exactly the seeds whose need this host lacks', () => {
    expect(systemSeeds.filter((seed) => !Object.hasOwn(seed, 'needs')).map((seed) => seed.name)).toEqual([]);
    const lacked = new Set<string>([
      ...(CANNOT_DENY_READS ? ['denyReads'] : []),
      ...(symlinkCapability() === null ? ['symlinks'] : []),
    ]);
    // What the seed files themselves skip: seedFile spreads these very cases.
    const cases = (Object.keys(SYSTEM_SEEDS) as SeedFileKey[]).flatMap((key) => seedCases(key));
    expect(cases.map((seedCase) => seedCase.seed)).toEqual(systemSeeds);
    const skipped = cases.filter((seedCase) => seedCase.unplantable).map((seedCase) => seedCase.seed.name);
    expect(skipped).toEqual(systemSeeds.filter((seed) => seed.needs !== null && lacked.has(seed.needs)).map((seed) => seed.name));
    if (process.env['CI'] !== undefined && process.platform === 'linux') {
      expect(skipped, 'no seed may be skipped on Linux CI').toEqual([]);
    }
  });

  it('judges a seed\'s runs by its path as a whole quoted value, never a substring', () => {
    expect(namesPath('{"path":"locked","code":"X"}', 'locked')).toBe(true);
    expect(namesPath('location: "docs/linked.md"', 'docs/linked.md')).toBe(true);
    expect(namesPath(String.raw`{"row":"{\"path\":\"locked\"}"}`, 'locked')).toBe(true);
    expect(namesPath(String.raw`{"row":"{\"path\":\"locked/hidden.md\"}"}`, 'locked')).toBe(false);
    expect(namesPath('{"path":"locked/hidden.md"}', 'locked')).toBe(false);
    expect(namesPath('{"path":"unlocked"}', 'locked')).toBe(false);
    expect(namesPath('the locked directory', 'locked')).toBe(false);
  });
});
