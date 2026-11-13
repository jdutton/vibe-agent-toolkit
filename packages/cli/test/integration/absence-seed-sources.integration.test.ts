/**
 * The absence-cause seeds, held against the source files that carry them. This
 * reads every package's TypeScript and parses it, so it runs in the
 * integration tier; the pure assertions on the enumeration stay in the unit
 * tier (`absence-causes.test.ts`).
 *
 * - Each system seed file is exactly its template, so a seed cannot be deleted
 *   or skipped in the file.
 * - Each lower-tier seed's named test exists, runs, and calls
 *   `expectAbsenceCause` on rows it did not write by hand, with the member's
 *   own signature; and every `expectAbsenceCause` call outside `utils` and the
 *   harness is one of those seeds, with no other way of reaching it.
 * - The finder's own accept and red controls.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as resources from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import type { ABSENCE_MEMBER_KEYS } from '../helpers/absence-causes.js';
import { LOWER_TIER_SEEDS, seedFilePath, seedFileText, SYSTEM_SEEDS, type SeedFileKey } from '../helpers/absence-seeds.js';
import { judgeLowerTierTest, lowerTierCallSites } from '../helpers/lower-tier-finder.js';

const REPO_ROOT = safePath.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

/** Sorted, so a set compares as a list with a readable diff. */
function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

describe('the seeds against their source files', () => {
  it.each(Object.keys(SYSTEM_SEEDS) as SeedFileKey[])('holds the %s seed file to its template', (key) => {
    expect(readFileSync(safePath.join(REPO_ROOT, seedFilePath(key)), 'utf-8')).toBe(seedFileText(key));
  });

  it.each(LOWER_TIER_SEEDS.map((seed) => [seed.member, seed] as const))('lower-tier seed %s names a test that plants its member', (member, seed) => {
    const source = readFileSync(safePath.join(REPO_ROOT, seed.file), 'utf-8');
    expect(judgeLowerTierTest(source, seed.file, seed.testName, member)).toEqual([]);
  });

  it('maps every expectAbsenceCause call outside utils and the harness to exactly one lower-tier seed, reached no other way', () => {
    const named = LOWER_TIER_SEEDS.map((seed) => `${seed.file} :: ${seed.testName}`);
    const { sites, strays } = lowerTierCallSites(REPO_ROOT);
    const keys = sites.map((site) => `${site.file} :: ${site.test ?? '(no enclosing test)'}`);
    expect(strays).toEqual([]);
    expect(sorted(keys)).toEqual(sorted(named));
    expect(keys.filter((site, index) => keys.indexOf(site) !== index), 'a seed\'s test with more than one call').toEqual([]);
  });
});

describe('the call-site scan\'s own controls', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** A repository holding one package whose test tree carries the given files. */
  const repoWith = (files: Readonly<Record<string, string>>): string => {
    const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-call-sites-'));
    roots.push(root);
    const testDir = safePath.join(root, 'packages', 'pkg', 'test');
    mkdirSyncReal(testDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(safePath.join(testDir, name), text);
    return root;
  };
  const IMPORT = "import { expectAbsenceCause } from '@vibe-agent-toolkit/utils/testing';\n";

  it('scans .mts and .cts files as well as .ts', () => {
    const call = "it('t', () => { expectAbsenceCause(rows, { code: X }); });";
    const { sites } = lowerTierCallSites(repoWith({ 'a.ts': IMPORT + call, 'b.mts': IMPORT + call, 'c.cts': IMPORT + call }));
    expect(sorted(sites.map((site) => site.file))).toEqual(['packages/pkg/test/a.ts', 'packages/pkg/test/b.mts', 'packages/pkg/test/c.cts']);
  });

  it('counts a call through an alias or a namespace, and reports every other reach as a stray', () => {
    const { sites, strays } = lowerTierCallSites(repoWith({
      'alias.ts': "import { expectAbsenceCause as check } from '@vibe-agent-toolkit/utils/testing';\nit('a', () => { check(rows, sig); });",
      'ns.ts': "import * as testing from '@vibe-agent-toolkit/utils/testing';\nit('n', () => { testing.expectAbsenceCause(rows, sig); });",
      'stray.ts': `${IMPORT}const f = expectAbsenceCause;\nit('s', () => { f(rows, sig); });`,
    }));
    expect(sorted(sites.map((site) => site.test ?? ''))).toEqual(['a', 'n']);
    expect(strays.join('\n')).toMatch(/stray\.ts/);
  });

  it('reports a reach by element access on no namespace as a stray', () => {
    const text = "it('d', async () => { (await import('@vibe-agent-toolkit/utils/testing'))['expectAbsenceCause'](rows, sig); });";
    const { sites, strays } = lowerTierCallSites(repoWith({ 'dynamic.ts': text }));
    expect(sites).toEqual([]);
    expect(strays.join('\n')).toMatch(/dynamic\.ts:1: .*\['expectAbsenceCause'\]/);
  });

  it('keeps one site per call, so a test with two calls shows two', () => {
    const { sites } = lowerTierCallSites(repoWith({ 'twice.ts': `${IMPORT}it('t', () => { expectAbsenceCause(rows, sig); expectAbsenceCause(rows, sig); });` }));
    expect(sites).toEqual([{ file: 'packages/pkg/test/twice.ts', test: 't' }, { file: 'packages/pkg/test/twice.ts', test: 't' }]);
  });
});

describe('the lower-tier finder\'s own controls', () => {
  type Member = (typeof ABSENCE_MEMBER_KEYS)[number];
  const UNREADABLE = resources.BLOB_UNREADABLE;
  const SIGNATURE = '{ code: BLOB_UNREADABLE }';
  /** The imports every fixture's names resolve through. */
  const HEADER = [
    "import { CANNOT_DENY_READS, expectAbsenceCause, PERMISSIONS_ENFORCED } from '@vibe-agent-toolkit/utils/testing';",
    "import { symlinkCapability } from '@vibe-agent-toolkit/utils';",
    "import { BLOB_CONTENT_CHANGED, BLOB_UNREADABLE, PACKAGE_SUBPATH_NOT_EXPORTED } from '../src/codes.js';",
    '',
  ].join('\n');
  /** One fixture file, without the shared imports, holding one test titled `t`. */
  const judgeRaw = (text: string, member: Member = UNREADABLE): string[] => judgeLowerTierTest(text, 'fixture.ts', 't', member);
  /** One fixture file, with the shared imports, holding one test titled `t`. */
  const judge = (body: string, member: Member = UNREADABLE): string[] => judgeRaw(HEADER + body, member);
  /** A test titled `t` with the given callee chain and one plain call. */
  const gated = (chain: string): string => `${chain}('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`;

  it.each([
    ['a plain statement', `it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['the direct argument of expect', `it('t', async () => { expect(expectAbsenceCause(projection, ${SIGNATURE})).toHaveLength(1); });`],
    ['an it.each title', `it.each([1])('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['skipIf on a host that cannot deny reads', gated('it.skipIf(CANNOT_DENY_READS)')],
    ['runIf on a host that enforces permissions', gated('test.runIf(PERMISSIONS_ENFORCED)')],
    ['skipIf on a host without symlinks', gated('it.skipIf(symlinkCapability() === null)')],
    ['runIf on a host with symlinks', gated('it.runIf(symlinkCapability() !== null)')],
    ['rows from a helper call', `it('t', () => { const rows = rowsOf(contribution); expectAbsenceCause(rows, ${SIGNATURE}); });`],
    ['an options object that skips nothing', `it('t', { timeout: 5000, skip: false }, () => { expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['a context property other than skip', `it('t', ({ onTestFinished }) => { onTestFinished(() => {}); expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['a return after the call', `it('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); return; });`],
    ['a return inside a nested function before the call', `it('t', () => { const f = () => { return 1; }; f(); expectAbsenceCause(projection, ${SIGNATURE}); });`],
  ])('accepts %s', (_label, body) => {
    expect(judge(body)).toEqual([]);
  });

  it.each([
    ['an aliased import of the callee', "import { expectAbsenceCause as check } from '@vibe-agent-toolkit/utils/testing';\nimport { BLOB_UNREADABLE } from '../src/codes.js';\nit('t', () => { check(projection, { code: BLOB_UNREADABLE }); });"],
    ['a namespace import of the testing module', "import * as testing from '@vibe-agent-toolkit/utils/testing';\nimport { BLOB_UNREADABLE } from '../src/codes.js';\nit('t', () => { testing.expectAbsenceCause(projection, { code: BLOB_UNREADABLE }); });"],
    ['a code under an aliased import', "import { expectAbsenceCause } from '@vibe-agent-toolkit/utils/testing';\nimport { BLOB_UNREADABLE as UNREADABLE } from '../src/codes.js';\nit('t', () => { expectAbsenceCause(projection, { code: UNREADABLE }); });"],
    ['a code through a namespace import', "import { expectAbsenceCause } from '@vibe-agent-toolkit/utils/testing';\nimport * as codes from '../src/codes.js';\nit('t', () => { expectAbsenceCause(projection, { code: codes.BLOB_UNREADABLE }); });"],
  ])('accepts %s', (_label, text) => {
    expect(judgeRaw(text)).toEqual([]);
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
    ['a code bound to something other than an import or a string', `const CODE = pick(BLOB_UNREADABLE); it('t', () => { expectAbsenceCause(projection, { code: CODE }); });`, /signature/],
    ['a code read off a name that is no namespace import', `it('t', () => { expectAbsenceCause(projection, { code: table.BLOB_UNREADABLE }); });`, /signature/],
    ['it.skip', gated('it.skip'), /skipped/],
    ['it.todo', gated('it.todo'), /skipped/],
    ['it.fails', gated('it.fails'), /skipped/],
    ['skipIf on no host constant', gated('it.skipIf(flaky)'), /skipped/],
    ['runIf on no host constant', gated('it.runIf(false)'), /skipped/],
    ['skipIf on an inverted read gate', gated('it.skipIf(!CANNOT_DENY_READS)'), /skipped/],
    ['runIf on the read gate that skips', gated('it.runIf(CANNOT_DENY_READS)'), /skipped/],
    ['skipIf on the permissions gate', gated('it.skipIf(PERMISSIONS_ENFORCED)'), /skipped/],
    ['runIf on an inverted permissions gate', gated('it.runIf(!PERMISSIONS_ENFORCED)'), /skipped/],
    ['skipIf when symlinks work', gated('it.skipIf(symlinkCapability() !== null)'), /skipped/],
    ['runIf when symlinks do not work', gated('it.runIf(symlinkCapability() === null)'), /skipped/],
    ['a local constant named like a host gate', `const CANNOT_DENY_READS = true; ${gated('it.skipIf(CANNOT_DENY_READS)')}`, /skipped/],
    ['an options object that skips', `it('t', { skip: true }, () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['an options object that is todo', `it('t', { todo: true }, () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['an options object that fails', `it('t', { fails: true }, () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['an options key that skips on a name', `it('t', { skip: flaky }, () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['an options key in shorthand', `const skip = flaky; it('t', { skip }, () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['an options object bound to a name', `const options = { skip: true }; it('t', options, () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['an options object with a spread', `it('t', { ...options }, () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['an options object the test cannot read', `it('t', optionsFor('t'), () => { expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['describe.skip', `describe.skip('d', () => { ${gated('it')} });`, /skipped/],
    ['describe.skipIf', `describe.skipIf(CANNOT_DENY_READS)('d', () => { ${gated('it')} });`, /skipped/],
    ['describe.runIf', `describe.runIf(PERMISSIONS_ENFORCED)('d', () => { ${gated('it')} });`, /skipped/],
    ['describe.todo', `describe.todo('d', () => { ${gated('it')} });`, /skipped/],
    ['describe.fails', `describe.fails('d', () => { ${gated('it')} });`, /skipped/],
    ['a describe options object that skips', `describe('d', { skip: true }, () => { ${gated('it')} });`, /skipped/],
    ['a describe options object that is todo', `describe('d', { todo: true }, () => { ${gated('it')} });`, /skipped/],
    ['a describe options object that fails', `describe('d', { fails: true }, () => { ${gated('it')} });`, /skipped/],
    ['a skip deep in a describe chain', `describe.concurrent.skip('d', () => { ${gated('it')} });`, /skipped/],
    ['a call to the context\'s skip', `it('t', (context) => { context.skip(); expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['a call to a destructured skip', `it('t', ({ skip }) => { skip(); expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['a call to a renamed destructured skip', `it('t', ({ skip: pass }) => { pass(); expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['the context handed on whole', `it('t', (context) => { skipUnlessReady(context); expectAbsenceCause(projection, ${SIGNATURE}); });`, /skipped/],
    ['an early return', `it('t', () => { return; expectAbsenceCause(projection, ${SIGNATURE}); });`, /return/],
    ['a conditional return', `it('t', () => { if (CANNOT_DENY_READS) return; expectAbsenceCause(projection, ${SIGNATURE}); });`, /return/],
    ['a return in a loop', `it('t', () => { for (const x of xs) { if (x) { return; } } expectAbsenceCause(projection, ${SIGNATURE}); });`, /return/],
  ])('reds %s', (_label, body, problem) => {
    expect(judge(body).join('\n')).toMatch(problem);
  });

  it.each([
    ['a callee imported from another module', "import { expectAbsenceCause } from './spoof.js';\nimport { BLOB_UNREADABLE } from '../src/codes.js';\nit('t', () => { expectAbsenceCause(projection, { code: BLOB_UNREADABLE }); });"],
    ['a local function of the callee\'s name', "import { BLOB_UNREADABLE } from '../src/codes.js';\nfunction expectAbsenceCause(rows, signature) { return []; }\nit('t', () => { expectAbsenceCause(projection, { code: BLOB_UNREADABLE }); });"],
    ['the callee rebound to another name', `${HEADER}const check = expectAbsenceCause;\nit('t', () => { check(projection, ${SIGNATURE}); expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['the callee read by element access', `import * as testing from '@vibe-agent-toolkit/utils/testing';\n${HEADER}it('t', () => { testing['expectAbsenceCause'](projection, ${SIGNATURE}); expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['the callee destructured from a namespace', `import * as testing from '@vibe-agent-toolkit/utils/testing';\n${HEADER}const { expectAbsenceCause: check } = testing;\nit('t', () => { check(projection, ${SIGNATURE}); expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['the callee re-exported', `${HEADER}export { expectAbsenceCause } from '@vibe-agent-toolkit/utils/testing';\nit('t', () => { expectAbsenceCause(projection, ${SIGNATURE}); });`],
    ['the callee from a dynamic import', `${HEADER}it('t', async () => { (await import('@vibe-agent-toolkit/utils/testing')).expectAbsenceCause(projection, ${SIGNATURE}); expectAbsenceCause(projection, ${SIGNATURE}); });`],
  ])('reds %s', (_label, text) => {
    expect(judgeRaw(text).join('\n')).toMatch(/reaches expectAbsenceCause other than|no counted/);
  });

  it('reds a code name that nothing in the file binds', () => {
    const text = "import { expectAbsenceCause } from '@vibe-agent-toolkit/utils/testing';\nit('t', () => { expectAbsenceCause(projection, { code: BLOB_UNREADABLE }); });";
    expect(judgeRaw(text).join('\n')).toMatch(/signature/);
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
