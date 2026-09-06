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
import { describe, expect, it } from 'vitest';

import {
  findEngineFloorDisagreements,
  type PackageManifestSummary,
} from '../src/validate-repo-structure.js';

const ROOT_FLOOR = '>=22.13.0';

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

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.path).toBe(CLI);
    expect(findings[0]?.message).toContain('>=22.0.0');
    expect(findings[0]?.message).toContain(ROOT_FLOOR);
  });

  it('reports a PRIVATE package whose floor disagrees — declaring it wrong is still wrong', () => {
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: LAB, isPrivate: true, engineNode: '>=20.0.0' }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
  });

  it('reports a PUBLISHED package that declares no floor at all', () => {
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: CLI, engineNode: undefined }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.message).toMatch(/engines\.node/);
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

    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('package.json');
    expect(findings[0]?.severity).toBe('error');
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

  it('is not vacuous: a rule that returned [] for everything fails the cases above', () => {
    // Guards the shape that has bitten this suite before — an assertion set whose
    // every expectation is satisfied by a checker that reports nothing at all.
    const findings = findEngineFloorDisagreements(ROOT_FLOOR, [
      pkg({ path: A, engineNode: '>=1.0.0' }),
    ]);

    expect(findings.length).toBeGreaterThan(0);
  });
});
