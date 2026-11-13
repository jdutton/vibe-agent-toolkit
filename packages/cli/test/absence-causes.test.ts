/**
 * The absence-cause enumeration, held both ways: against the static domain of
 * codes the packages export, and against its seeds.
 *
 * - Every code (and content state) in the static domain is classified exactly
 *   once, and nothing is classified that the domain does not hold.
 * - The seeded causes are the members: a member with no seed reds, and a seed
 *   naming anything else reds (test files are not typechecked, so the member
 *   type on a seed is documentation, and this is the check that fires).
 * - Each system seed file is exactly its template, so a seed cannot be deleted
 *   or skipped in the file; a seed is skipped only on a host that lacks its
 *   declared need.
 * - Each lower-tier seed's named test exists, runs, and calls
 *   `expectAbsenceCause` on rows it did not write by hand, with the member's
 *   own signature; and every `expectAbsenceCause` call outside `utils` and the
 *   harness is one of those seeds.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as agentSkills from '@vibe-agent-toolkit/agent-skills';
import * as claudeMarketplace from '@vibe-agent-toolkit/claude-marketplace';
import * as resources from '@vibe-agent-toolkit/resources';
import { safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
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
import {
  causeOf,
  LOWER_TIER_SEEDS,
  namesPath,
  seedFilePath,
  seedFileText,
  SYSTEM_SEEDS,
  unplantableHere,
  type SeedFileKey,
} from './helpers/absence-seeds.js';
import { judgeLowerTierTest, lowerTierCallSites } from './helpers/lower-tier-finder.js';

const REPO_ROOT = safePath.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

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

  it.each(Object.keys(SYSTEM_SEEDS) as SeedFileKey[])('holds the %s seed file to its template', (key) => {
    expect(readFileSync(safePath.join(REPO_ROOT, seedFilePath(key)), 'utf-8')).toBe(seedFileText(key));
  });

  it('declares every system seed\'s host need, and skips exactly the seeds whose need this host lacks', () => {
    expect(systemSeeds.filter((seed) => !Object.hasOwn(seed, 'needs')).map((seed) => seed.name)).toEqual([]);
    const lacked = new Set<string>([
      ...(CANNOT_DENY_READS ? ['denyReads'] : []),
      ...(symlinkCapability() === null ? ['symlinks'] : []),
    ]);
    const skipped = systemSeeds.filter((seed) => unplantableHere(seed)).map((seed) => seed.name);
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

describe('each lower-tier seed names a test that plants its member', () => {
  it.each(LOWER_TIER_SEEDS.map((seed) => [seed.member, seed] as const))('%s', (member, seed) => {
    const source = readFileSync(safePath.join(REPO_ROOT, seed.file), 'utf-8');
    expect(judgeLowerTierTest(source, seed.file, seed.testName, member)).toEqual([]);
  });

  it('maps every expectAbsenceCause call outside utils and the harness to exactly one lower-tier seed', () => {
    const named = LOWER_TIER_SEEDS.map((seed) => `${seed.file} :: ${seed.testName}`);
    const sites = lowerTierCallSites(REPO_ROOT).map((site) => `${site.file} :: ${site.test ?? '(no enclosing test)'}`);
    expect(sorted(sites)).toEqual(sorted(named));
    expect(sites.filter((site, index) => sites.indexOf(site) !== index), 'a seed\'s test with more than one call').toEqual([]);
  });
});

describe('the lower-tier finder\'s own controls', () => {
  const UNREADABLE = resources.BLOB_UNREADABLE;
  const SIGNATURE = '{ code: BLOB_UNREADABLE }';
  /** One fixture file holding one test titled `t`. */
  const judge = (body: string, member: (typeof ABSENCE_MEMBER_KEYS)[number] = UNREADABLE): string[] =>
    judgeLowerTierTest(body, 'fixture.ts', 't', member);

  it.each([
    ['a plain statement', `it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['the direct argument of expect', `it('t', async () => { expect(expectAbsenceCause(projection, ${SIGNATURE})).toHaveLength(1); });`],
    ['an it.each title', `it.each([1])('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['a host-gated skipIf', `it.skipIf(CANNOT_DENY_READS)('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['a host-gated runIf', `test.runIf(PERMISSIONS_ENFORCED)('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['rows from a helper call', `it('t', () => { const rows = rowsOf(contribution); expectAbsenceCause(rows, ${SIGNATURE}); });`],
  ])('accepts %s', (_label, body) => {
    expect(judge(body)).toEqual([]);
  });

  it.each([
    ['no test of that title', `it('other', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /exactly one test/],
    ['two tests of that title', `it('t', () => {}); it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /exactly one test/],
    ['a call inside try', `it('t', () => { try { expectAbsenceCause(projection, ${SIGNATURE}); } finally {} });`, /no counted/],
    ['a call inside catch', `it('t', () => { try { run(); } catch { expectAbsenceCause(projection, ${SIGNATURE}); } });`, /no counted/],
    ['a call expected to throw', `it('t', () => { expect(() => expectAbsenceCause(projection, ${SIGNATURE})).toThrow(); });`, /no counted/],
    ['a call in a nested function', `it('t', () => { const check = () => expectAbsenceCause(projection, ${SIGNATURE}); check(); });`, /no counted/],
    ['rows written inline', `it('t', () => { expectAbsenceCause({ blobConditions: [] }, ${SIGNATURE}); });`, /by hand/],
    ['rows bound to an object literal', `it('t', () => { const rows = { blobConditions: [] } as AbsenceRows; expectAbsenceCause(rows, ${SIGNATURE}); });`, /by hand/],
    ['a signature that is no literal', 'it(\'t\', () => { expectAbsenceCause(projection, signature); });', /signature/],
    ['another member\'s code', 'it(\'t\', () => { expectAbsenceCause(projection, { code: BLOB_CONTENT_CHANGED }); });', /signature/],
    ['a local constant spoofing the code', `const BLOB_UNREADABLE = 'BLOB_PARSE_FAILED'; it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /signature/],
    ['it.skip', `it.skip('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['it.todo', `it.todo('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['skipIf on no host constant', `it.skipIf(flaky)('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['runIf on no host constant', `it.runIf(false)('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['describe.skip', `describe.skip('d', () => { it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); }); });`, /skipped/],
    ['describe.skipIf', `describe.skipIf(CANNOT_DENY_READS)('d', () => { it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); }); });`, /skipped/],
    ['describe.runIf', `describe.runIf(PERMISSIONS_ENFORCED)('d', () => { it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); }); });`, /skipped/],
    ['describe.todo', `describe.todo('d', () => { it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); }); });`, /skipped/],
    ['a skip deep in a describe chain', `describe.concurrent.skip('d', () => { it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); }); });`, /skipped/],
  ])('reds %s', (_label, body, problem) => {
    expect(judge(body).join('\n')).toMatch(problem);
  });

  it('reds a signature missing a field of the member\'s, or stating one with another value', () => {
    const member = resources.PACKAGE_SUBPATH_NOT_EXPORTED;
    const call = (signature: string): string => `it('t', () => { expectAbsenceCause(rowsOf(c), ${signature}); });`;
    expect(judge(call("{ code: PACKAGE_SUBPATH_NOT_EXPORTED, extentKind: 'package', resourceIdPresent: true }"), member)).toEqual([]);
    expect(judge(call("{ code: PACKAGE_SUBPATH_NOT_EXPORTED, extentKind: 'package' }"), member).join('\n')).toMatch(/signature/);
    expect(judge(call("{ code: PACKAGE_SUBPATH_NOT_EXPORTED, extentKind: 'package', resourceIdPresent: false }"), member).join('\n')).toMatch(/signature/);
    expect(judge(call("{ code: PACKAGE_SUBPATH_NOT_EXPORTED, extentKind: 'filesystem', resourceIdPresent: true }"), member).join('\n')).toMatch(/signature/);
  });
});
