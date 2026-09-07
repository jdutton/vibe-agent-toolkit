/**
 * Unit tests for the Node engine-floor agreement rule.
 *
 * The repo raised its floor to `>=22.13.0` across 23 manifests, and nothing
 * asserted that they agree. The only floor test in the tree pinned a single
 * package (`packages/utils`) with a literal, while `vat doctor` reads
 * `packages/cli` — so the two could drift apart and every test would stay green.
 * "One source of truth" was a convention held in a contributor's memory, not a
 * mechanism, which is exactly the shape that let thirteen patch releases ship a
 * floor the code did not honour.
 *
 * These tests pin the pure decision function directly. The floor is DERIVED from
 * the root manifest rather than restated here: a literal in this file would be a
 * second place to remember, which is the defect it is meant to catch.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import {
  collectEngineFloorFindings,
  findEngineFloorDisagreements,
  type PackageManifestSummary,
} from '../src/validate-repo-structure.js';

const ROOT_MANIFEST = 'package.json';

/**
 * Read from the root manifest, not restated — see the header. That header used
 * to make this claim while `ROOT_FLOOR` below was the literal `'>=22.13.0'`,
 * telling a reader the file pinned the real floor when it pinned an inert
 * sentinel (the function under test takes the floor as a parameter, so the value
 * never had to be right).
 *
 * Throwing on absence rather than defaulting: an empty floor here would make
 * every assertion below compare `''` to `''` and pass for the wrong reason.
 */
function readRootFloor(): string {
  const manifestPath = safePath.join(PROJECT_ROOT, ROOT_MANIFEST);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    engines?: { node?: string };
  };
  const floor = manifest.engines?.node;
  if (floor === undefined || floor === '') {
    throw new Error(`Root manifest ${manifestPath} declares no engines.node to derive a floor from`);
  }
  return floor;
}

const ROOT_FLOOR = readRootFloor();

const CLI = 'packages/cli/package.json';
const UTILS = 'packages/utils/package.json';
const LAB = 'packages/lab/package.json';
const DEV_TOOLS = 'packages/dev-tools/package.json';
const TEST_AGENTS = 'packages/test-agents/package.json';
const A = 'packages/a/package.json';
const B = 'packages/b/package.json';
const C = 'packages/c/package.json';
const D = 'packages/d/package.json';

function pkg(overrides: Partial<PackageManifestSummary> = {}): PackageManifestSummary {
  return {
    path: 'packages/example/package.json',
    isPrivate: false,
    engineNode: ROOT_FLOOR,
    ...overrides,
  };
}

/**
 * The single-offender assertion, in one place. Every case below asserts the same
 * four things about `findings[0]`; written out per test they were a jscpd clone
 * and, worse, each copy could drift into asserting a slightly different subset.
 */
function expectOneError(
  findings: readonly { severity: string; path: string; message: string }[],
  expected: { path?: string; contains?: readonly string[]; absent?: string; matches?: RegExp },
): void {
  expect(findings).toHaveLength(1);
  const finding = findings[0];
  expect(finding?.severity).toBe('error');
  if (expected.path !== undefined) {
    expect(finding?.path).toBe(expected.path);
  }
  for (const needle of expected.contains ?? []) {
    expect(finding?.message).toContain(needle);
  }
  if (expected.absent !== undefined) {
    expect(finding?.message).not.toContain(expected.absent);
  }
  if (expected.matches !== undefined) {
    expect(finding?.message).toMatch(expected.matches);
  }
}

describe('findEngineFloorDisagreements', () => {
  it('reports nothing when every published package matches the root floor', () => {
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: CLI }),
      pkg({ path: UTILS }),
    ]);

    expect(findings).toEqual([]);
  });

  it('reports a published package whose floor disagrees with the root', () => {
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: CLI, engineNode: '>=22.0.0' }),
    ]);

    expectOneError(findings, { path: CLI, contains: ['>=22.0.0', ROOT_FLOOR] });
  });

  it('reports a PRIVATE package whose floor disagrees — declaring it wrong is still wrong', () => {
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: LAB, isPrivate: true, engineNode: '>=20.0.0' }),
    ]);

    expectOneError(findings, {});
  });

  it('reports a PUBLISHED package that declares no floor at all', () => {
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: CLI, engineNode: undefined }),
    ]);

    expectOneError(findings, { matches: /engines\.node/ });
  });

  it('allows a PRIVATE package to omit the floor — it is never installed by an adopter', () => {
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: DEV_TOOLS, isPrivate: true, engineNode: undefined }),
      pkg({ path: LAB, isPrivate: true, engineNode: undefined }),
      pkg({ path: TEST_AGENTS, isPrivate: true, engineNode: undefined }),
    ]);

    expect(findings).toEqual([]);
  });

  it('reports the ROOT itself when it declares no floor, because nothing can be derived', () => {
    const findings = findEngineFloorDisagreements(undefined, [pkg()]);

    expectOneError(findings, { path: ROOT_MANIFEST });
  });

  it('reports every offender, not just the first', () => {
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: A, engineNode: '>=22.0.0' }),
      pkg({ path: B, engineNode: undefined }),
      pkg({ path: C }),
      pkg({ path: D, engineNode: '>=24.0.0' }),
    ]);

    expect(findings.map((f) => f.path)).toEqual([
      A,
      B,
      D,
    ]);
  });

  /**
   * A manifest the gate cannot READ is a finding, not a pass.
   *
   * Measured on a scratch tree before this existed, baseline 28 errors:
   * deleting `engines` from a published package took it to 29 (the rule fires),
   * but making that same manifest INVALID JSON took it back to 28 — silent, with
   * no rule reporting anything. `readManifest` returned `undefined` on ANY
   * failure and the caller `continue`d, so "this file is corrupt" and "this
   * directory has no manifest" were the same answer, and the corrupt one escaped
   * every rule written to constrain it.
   */
  describe('a manifest that cannot be read', () => {
    it('reports an unparseable package manifest instead of skipping it', () => {
      const findings = findEngineFloorDisagreements(ROOT_FLOOR, [], [
        { path: CLI, reason: 'Unexpected token } in JSON at position 12' },
      ]);

      expectOneError(findings, { path: CLI, contains: ['Unexpected token'] });
    });

    it('reports a failure to enumerate packages/ rather than passing the whole gate', () => {
      const findings = findEngineFloorDisagreements(ROOT_FLOOR, [], [
        { path: 'packages', reason: "ENOENT: no such file or directory, scandir 'packages'" },
      ]);

      expectOneError(findings, { path: 'packages' });
    });

    it('reports an unreadable ROOT manifest as unreadable, not as "declares no floor"', () => {
      const findings = findEngineFloorDisagreements(undefined, [pkg()], [
        { path: ROOT_MANIFEST, reason: 'Unexpected end of JSON input' },
      ]);

      // The two are different defects with different fixes, and conflating them
      // sends the reader to add a key to a file that will not parse.
      expectOneError(findings, {
        path: ROOT_MANIFEST,
        contains: ['Unexpected end of JSON input'],
        absent: 'declares no engines.node',
      });
    });

    it('still checks every readable manifest alongside an unreadable one', () => {
      const findings = findEngineFloorDisagreements(
        ROOT_FLOOR,
        [pkg({ path: A, engineNode: '>=20.0.0' }), pkg({ path: C })],
        [{ path: B, reason: 'Unexpected token' }],
      );

      expect(findings.map((f) => f.path).sort((a, b) => a.localeCompare(b))).toEqual([A, B]);
    });
  });

  it('is not vacuous: a rule that returned [] for everything fails the cases above', () => {
    // Guards the shape that has bitten this suite before — an assertion set whose
    // every expectation is satisfied by a checker that reports nothing at all.
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: A, engineNode: '>=1.0.0' }),
    ]);

    expect(findings.length).toBeGreaterThan(0);
  });
});

/**
 * The WIRING, against a real tree — because every case above hand-feeds the pure
 * decision function an `unreadable[]` array it built itself.
 *
 * 🪤 That is the gap this block closes. `readManifest` is what decides whether a
 * corrupt manifest ever *becomes* an `unreadable[]` entry, and it was reachable
 * from no test at all: replacing its three-outcome body with the pre-fix
 * swallow-all (`catch { return { kind: 'absent' } }`) left the whole suite green
 * — the fix the branch exists for was pinned only by the assertions that assume
 * it already happened.
 *
 * So these drive `collectEngineFloorFindings` at a fixture root and assert the
 * three outcomes stay APART on a real filesystem:
 *
 * | on disk                          | expected |
 * |----------------------------------|----------|
 * | agreeing manifest                | silence  |
 * | directory with NO `package.json` | silence  |
 * | unparseable `package.json`       | FINDING  |
 * | `package.json` that cannot be opened at all | FINDING |
 *
 * The last row is a `package.json` that is a DIRECTORY rather than a file: it
 * yields `EISDIR`, an error that is neither `ENOENT` nor a JSON parse failure,
 * on every platform and without depending on chmod semantics that differ (and
 * on Windows, largely do not exist).
 */

/** Every fixture tree this file creates, torn down together. */
const fixtureRoots: string[] = [];

const FIXTURE_PREFIX = 'vat-floor-wiring-';

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** An empty scratch tree, registered for cleanup. */
function emptyRoot(): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), FIXTURE_PREFIX));
  fixtureRoots.push(root);
  return root;
}

function write(path: string, contents: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path under this file's own mkdtemp root
  writeFileSync(path, contents, 'utf8');
}

/** A minimal monorepo whose root declares the real floor. */
function fixtureRoot(): string {
  const root = emptyRoot();
  write(safePath.join(root, ROOT_MANIFEST), JSON.stringify({ engines: { node: ROOT_FLOOR } }));
  mkdirSyncReal(safePath.join(root, 'packages'), { recursive: true });
  return root;
}

/** Create `packages/<name>/`, then whatever the case needs inside it. */
function packageDir(root: string, name: string): string {
  const dir = safePath.join(root, 'packages', name);
  mkdirSyncReal(dir, { recursive: true });
  return dir;
}

function pathsOf(findings: readonly { path: string }[]): string[] {
  return findings.map((f) => f.path).sort((a, b) => a.localeCompare(b));
}

describe('collectEngineFloorFindings, wired to a real tree', () => {
  it('reports an unparseable manifest instead of skipping it like an absent one', async () => {
    const root = fixtureRoot();
    write(
      safePath.join(packageDir(root, 'agrees'), ROOT_MANIFEST),
      JSON.stringify({ engines: { node: ROOT_FLOOR } }),
    );
    // A directory that simply has no manifest — a legitimate pass, and the
    // outcome the swallow-all collapsed the corrupt case INTO.
    packageDir(root, 'no-manifest');
    write(safePath.join(packageDir(root, 'corrupt'), ROOT_MANIFEST), '{ "engines": { "node"');

    const findings = await collectEngineFloorFindings(root);

    expect(pathsOf(findings)).toEqual(['packages/corrupt/package.json']);
    expect(findings[0]?.severity).toBe('error');
    // The underlying cause is carried through, not flattened to "unreadable".
    expect(findings[0]?.message).toMatch(/JSON/u);
  });

  it('reports a manifest it cannot open at all', async () => {
    const root = fixtureRoot();
    // `package.json` as a DIRECTORY: readFile fails with EISDIR, which is
    // neither "not found" nor a parse error.
    mkdirSyncReal(safePath.join(packageDir(root, 'blocked'), ROOT_MANIFEST), { recursive: true });

    const findings = await collectEngineFloorFindings(root);

    expect(pathsOf(findings)).toEqual(['packages/blocked/package.json']);
    expect(findings[0]?.severity).toBe('error');
  });

  it('reports an unparseable ROOT manifest rather than "declares no floor"', async () => {
    const root = emptyRoot();
    write(safePath.join(root, ROOT_MANIFEST), 'not json at all');
    mkdirSyncReal(safePath.join(root, 'packages'), { recursive: true });

    const findings = await collectEngineFloorFindings(root);

    expect(pathsOf(findings)).toEqual([ROOT_MANIFEST]);
    expect(findings[0]?.message).not.toContain('declares no engines.node');
  });

  it('is silent on a tree where every manifest agrees', async () => {
    const root = fixtureRoot();
    write(
      safePath.join(packageDir(root, 'agrees'), ROOT_MANIFEST),
      JSON.stringify({ engines: { node: ROOT_FLOOR } }),
    );
    write(
      safePath.join(packageDir(root, 'private-no-floor'), ROOT_MANIFEST),
      JSON.stringify({ private: true }),
    );
    packageDir(root, 'no-manifest');

    expect(await collectEngineFloorFindings(root)).toEqual([]);
  });

  it('reports a real disagreement read off disk, so the read path is not inert', async () => {
    const root = fixtureRoot();
    write(
      safePath.join(packageDir(root, 'disagrees'), ROOT_MANIFEST),
      JSON.stringify({ engines: { node: '>=18.0.0' } }),
    );

    const findings = await collectEngineFloorFindings(root);

    expect(pathsOf(findings)).toEqual(['packages/disagrees/package.json']);
    expect(findings[0]?.message).toContain('>=18.0.0');
  });

  it('reports a missing packages/ directory rather than passing the whole gate', async () => {
    const root = emptyRoot();
    write(safePath.join(root, ROOT_MANIFEST), JSON.stringify({ engines: { node: ROOT_FLOOR } }));

    const findings = await collectEngineFloorFindings(root);

    expect(pathsOf(findings)).toEqual(['packages']);
  });
});
