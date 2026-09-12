/**
 * The RUN's conventional-suite probe reaches the looping PRODUCTION lanes.
 *
 * 🔑 **This asserts on the callers, not on the parameter.** `suiteProbe` landed on
 * `SkillValidationSharedContext` with a test that built the shared context itself
 * and handed the probe in — which proves the parameter is honoured, and says
 * nothing about whether any shipped command passes one. Nothing in
 * `packages/cli/src` did: `vat skills validate`, `vat skills build`'s pre-build
 * check and both `vat audit` lanes each built a context WITHOUT it, so every one
 * of them kept the full quadratic. Measured with the lab on a 103-skill adopter:
 * 10,815 probes over 103 distinct paths, half of that command's filesystem
 * traffic.
 *
 * So each row here drives the real entry point and COUNTS. A caller that stops
 * threading the run's probe goes from S probes to S², and the row goes red — an
 * assertion that the context merely accepts the field cannot see that.
 *
 * OBSERVABILITY. The count is read from a `node:fs` MODULE mock, the only seam
 * that sees `conventionalSuiteProbe`'s `existsSync` — it is an ESM named binding,
 * which a counter installed on the default export does not intercept. Same seam,
 * same reason, as `agent-skills/test/validators/test-input-probe-once.test.ts` —
 * but a DIFFERENT tally, because the two files measure different things. That one
 * counts probes in issue order to prove one CALL resolves each root once; this one
 * needs "each root exactly once across the whole RUN", which is a per-path count,
 * so the sink here is a `path → times probed` map. A `Map` equality names both
 * halves in one assertion and says WHICH root was over-probed; a flat list can only
 * say the total was wrong. The mock cannot be hoisted into a shared helper anyway:
 * `vi.mock` is per-module by construction.
 *
 * FIXTURE. FOUR skills in FOUR distinct directories, none declaring `test:` and
 * none carrying a suite. The distinctness is load-bearing — the probe memoizes by
 * path, so skills sharing one directory collapse to a single probe and cannot
 * tell S from S² — and four is the smallest S where the two counts are far enough
 * apart (4 vs 16) that a stray probe cannot be mistaken for the quadratic.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import type * as NodeFs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Forward-slash suite path → how many times the run asked the filesystem about it. */
const { probeCounts } = vi.hoisted(() => ({ probeCounts: new Map<string, number>() }));

/**
 * The conventional suite subpath, spelled here rather than imported: agent-skills
 * keeps `DEFAULT_EVALS_SUBPATH` off its public barrel, and a test in another
 * package reaching into its `src/` would pin an internal module path.
 */
const EVALS_SUBPATH = 'evals/evals.json';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  return {
    ...real,
    default: real,
    existsSync(target: Parameters<NodeFs['existsSync']>[0]): boolean {
      const probed = String(target).replaceAll('\\', '/');
      if (probed.endsWith(EVALS_SUBPATH)) probeCounts.set(probed, (probeCounts.get(probed) ?? 0) + 1);
      return real.existsSync(target);
    },
  };
});

const { buildAuditReport, resetAuditCaches } = await import('../../src/commands/audit.js');
const { runSkillsValidatePhase } = await import('../../src/commands/skills/validate.js');
const { resetSkillDiscoveryCache } = await import('../../src/skill-resolution/packaging-config.js');
const { silentLogger } = await import('../test-helpers.js');

/** Temp roots this file created, removed once at the end. */
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** Four skills, four directories — see the FIXTURE note in the file header. */
const SKILL_NAMES = ['alpha', 'beta', 'gamma', 'delta'];

/**
 * A project declaring {@link SKILL_NAMES}, each skill its own directory, no
 * `test:` block anywhere.
 *
 * The absent `test:` block is what makes the probe fire at all:
 * `declaredTestInputDirs` short-circuits before touching the filesystem for a
 * skill that DECLARES its suite, so a fixture with `test.evals` would count zero
 * probes and pass on the quadratic.
 */
function writeSkillProject(): string {
  const root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'run-scoped-suite-probe-')));
  tempRoots.push(root);
  for (const name of SKILL_NAMES) {
    const skillDir = safePath.join(root, 'skills', name);
    mkdirSyncReal(skillDir, { recursive: true });
    writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Fixture skill ${name} for counting conventional-suite probes.\n---\n\n# ${name}\n\nBody.\n`,
    );
  }
  writeFileSync(
    safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
    'version: 1\nskills:\n  include:\n    - "skills/*/SKILL.md"\n',
  );
  return root;
}

/**
 * The tally a run that shares one probe must produce: every skill root present,
 * each probed exactly once.
 *
 * One assertion carrying BOTH halves, deliberately. A bare total is satisfiable by
 * a lane that stopped resolving test input altogether (zero probes passes any
 * `toBeLessThan`), and a bare key set is satisfiable by the quadratic. The map
 * refuses both, and when it fails it names the root that was over-probed.
 */
function oneProbePerSkillRoot(root: string): Map<string, number> {
  return new Map(
    SKILL_NAMES.map((name) => [safePath.resolve(root, 'skills', name, EVALS_SUBPATH).replaceAll('\\', '/'), 1]),
  );
}

describe('the run-scoped conventional-suite probe reaches the production lanes', () => {
  beforeEach(() => {
    probeCounts.clear();
    resetAuditCaches();
    resetSkillDiscoveryCache();
  });

  it('vat skills validate probes each skill root once for the whole run', async () => {
    const root = writeSkillProject();

    await runSkillsValidatePhase(root, {});

    expect(probeCounts).toEqual(oneProbePerSkillRoot(root));
  });

  it('vat audit probes each skill root once for the whole run', async () => {
    const root = writeSkillProject();

    await buildAuditReport(root, {}, Date.now(), silentLogger as never);

    expect(probeCounts).toEqual(oneProbePerSkillRoot(root));
  });
});
