/**
 * Turning `okf.bundles` into runs.
 *
 * This is the whole of the config → validator translation, kept in `resources`
 * rather than in the CLI command so it is unit-testable against the config
 * schema's real types instead of through a spawned binary.
 */

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { okfBundleRuns } from '../../src/okf/config.js';
import { validateOkfBundle } from '../../src/okf/validate.js';
import type { OkfConfig } from '../../src/schemas/project-config.js';

/**
 * A config-file directory built from the real temp root.
 *
 * 🪤 NOT a `/project` literal. A POSIX-absolute literal has no drive letter, so
 * `safePath.resolve` gives it the CWD's drive on Windows and every expectation
 * written as `/project/...` fails there and only there.
 */
const CONFIG_DIR = safePath.join(normalizedTmpdir(), 'vat-okf-config-fixture');
const ELSEWHERE = safePath.join(normalizedTmpdir(), 'vat-okf-elsewhere', 'bundle');

const TWO_BUNDLES: OkfConfig = {
  bundles: {
    knowledge: { root: './knowledge' },
    playbooks: { root: 'ops/playbooks', severity: 'warning' },
  },
};

describe('okfBundleRuns', () => {
  it('returns one run per declared bundle, ordered by name', () => {
    const runs = okfBundleRuns(TWO_BUNDLES, CONFIG_DIR);

    expect(runs.map((run) => run.bundle)).toEqual(['knowledge', 'playbooks']);
  });

  it('resolves each root against the directory holding the config file', () => {
    const runs = okfBundleRuns(TWO_BUNDLES, CONFIG_DIR);

    expect(runs.map((run) => run.root)).toEqual([
      safePath.join(CONFIG_DIR, 'knowledge'),
      safePath.join(CONFIG_DIR, 'ops/playbooks'),
    ]);
  });

  it('leaves an absolute root alone', () => {
    const runs = okfBundleRuns({ bundles: { abs: { root: ELSEWHERE } } }, CONFIG_DIR);

    expect(runs[0]?.root).toBe(ELSEWHERE);
  });

  it('carries a declared severity through and omits an undeclared one', () => {
    const runs = okfBundleRuns(TWO_BUNDLES, CONFIG_DIR);

    // The default lives in `validateOkfBundle`, in one place. Stamping `error`
    // here as well would put the default in two, free to disagree.
    expect(Object.hasOwn(runs[0] ?? {}, 'severity')).toBe(false);
    expect(runs[1]?.severity).toBe('warning');
  });

  it('returns nothing when the project declares no OKF section', () => {
    expect(okfBundleRuns(undefined, CONFIG_DIR)).toEqual([]);
  });

  it('selects a single bundle by name', () => {
    const runs = okfBundleRuns(TWO_BUNDLES, CONFIG_DIR, { bundle: 'playbooks' });

    expect(runs.map((run) => run.bundle)).toEqual(['playbooks']);
  });

  it('names the declared bundles when asked for one that is not declared', () => {
    expect(() => okfBundleRuns(TWO_BUNDLES, CONFIG_DIR, { bundle: 'typo' }))
      .toThrow(/typo.*knowledge.*playbooks/s);
  });

  it('refuses a named bundle when the project declares no OKF section at all', () => {
    expect(() => okfBundleRuns(undefined, CONFIG_DIR, { bundle: 'knowledge' }))
      .toThrow(/okf\.bundles/);
  });

  it('passes a caller-supplied spec version through to every run', () => {
    const runs = okfBundleRuns(TWO_BUNDLES, CONFIG_DIR, { specVersion: '0.2' });

    expect(runs.map((run) => run.specVersion)).toEqual(['0.2', '0.2']);
  });
});

/**
 * 🪤 An `@`-scoped root used to THROW out of `okfBundleRuns`.
 *
 * `resolveAssetReference` reads `@scope/pkg/sub` as an npm bare specifier and,
 * unlike the unscoped form, gives it no path fallback: a scoped specifier that
 * does not resolve is rethrown as `Failed to resolve asset reference … run
 * install in <baseDir>`. That message carried the absolute config directory —
 * the developer's `$HOME` — and the throw escaped the whole command at exit 2,
 * discarding every OTHER declared bundle's findings.
 *
 * Config is user data, and user data must reach a FINDING rather than a
 * programming-error throw. That is the same ruling that already turned the
 * unreadable root, the unreadable subdirectory and the unreadable document into
 * findings in this lane.
 */
describe('a bundle root no installed package answers to', () => {
  const SCOPED_ROOT = '@vat-okf-fixture/not-installed/bundle';

  it('does not throw out of the run', () => {
    expect(() => okfBundleRuns({ bundles: { scoped: { root: SCOPED_ROOT } } }, CONFIG_DIR))
      .not.toThrow();
  });

  it('leaves every OTHER declared bundle in the run', () => {
    const runs = okfBundleRuns(
      { bundles: { knowledge: { root: './knowledge' }, scoped: { root: SCOPED_ROOT } } },
      CONFIG_DIR,
    );

    expect(runs.map((run) => run.bundle)).toEqual(['knowledge', 'scoped']);
  });

  it('carries the specifier verbatim, so no absolute path is published', () => {
    const runs = okfBundleRuns({ bundles: { scoped: { root: SCOPED_ROOT } } }, CONFIG_DIR);

    expect(runs[0]?.rootSpecifier).toBe(SCOPED_ROOT);
  });

  it('resolves it against the config directory, like every other non-package root', () => {
    const runs = okfBundleRuns({ bundles: { scoped: { root: SCOPED_ROOT } } }, CONFIG_DIR);

    expect(runs[0]?.root).toBe(safePath.join(CONFIG_DIR, SCOPED_ROOT));
  });

  it('reports it as an unreadable root, naming the specifier and the remedy', async () => {
    const runs = okfBundleRuns({ bundles: { scoped: { root: SCOPED_ROOT } } }, CONFIG_DIR);
    const run = runs[0];
    if (run === undefined) throw new Error('expected one run');

    const report = await validateOkfBundle(run);

    expect(report.findings.map((finding) => finding.code)).toEqual(['OKF_BUNDLE_ROOT_UNREADABLE']);
    expect(report.findings[0]?.message).toContain(SCOPED_ROOT);
    expect(report.root).toBe(SCOPED_ROOT);
    // The whole point of the specifier field: nothing in the report names the
    // directory the config file happens to sit in.
    expect(report.findings[0]?.message).not.toContain(CONFIG_DIR);
  });
});
