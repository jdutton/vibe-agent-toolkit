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
