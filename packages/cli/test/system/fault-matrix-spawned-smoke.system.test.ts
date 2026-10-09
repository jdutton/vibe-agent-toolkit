/**
 * The fault matrix runs verbs IN-PROCESS. This file proves that is the verdict the real binary
 * gives: the same fault, injected into a spawned `vat` through `fault-fs-preload`, ends the run
 * with the same exit code and the same refusal as the matrix's in-process run of the same rule.
 *
 * Two shapes the matrix exists for: a full disk while node-tar writes a plugin tarball into
 * staging (R7: that once exited 0 with a truncated install), and a file table exhausted at the
 * first file adm-zip opens for writing.
 */
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { faultRuleOf, installFaultFs, type FaultFsSpec, type FaultSpec } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';

import { pluginInstallCase, skillsInstallCase } from '../fault-matrix/cases/install-family.js';
import { makeCaseRoot, type CaseRoot, type VerbCase } from '../fault-matrix/drive.js';
import { runOnce } from '../fault-matrix/matrix.js';

import { createTempDirTracker, executeCli, getBinPath, getMonorepoRoot } from './test-common.js';

const binPath = getBinPath(import.meta.url);
const preload = safePath.join(getMonorepoRoot(import.meta.url), 'packages', 'utils', 'dist', 'testing', 'fault-fs-preload.js');
const scratch = createTempDirTracker('vat-fault-smoke-');
afterAll(() => scratch.cleanupTempDirs());

interface Smoke {
  readonly name: string;
  readonly c: VerbCase;
  /** The command words before the case's own argv (its group's place in the `vat` tree). */
  readonly command: readonly string[];
  /** The one fault, for a case rooted at `r`. */
  readonly fault: (r: CaseRoot) => FaultSpec;
}

const SMOKES: readonly Smoke[] = [
  {
    name: 'plugin install <tgz>, ENOSPC on the 2nd write into its $TMPDIR staging',
    c: pluginInstallCase('tgz', 'fresh'),
    command: ['claude', 'plugin'],
    fault: (r) => ({ family: 'write', op: 'write', pathIncludes: `${toForwardSlash(r.tmp)}/vat-install-tgz-`, nth: 2, errno: 'ENOSPC' }),
  },
  {
    name: 'skills install <zip>, EMFILE on the first open for write',
    c: skillsInstallCase('zip', 'fresh'),
    command: ['skills'],
    fault: (r) => ({ family: 'write', op: 'open', pathIncludes: toForwardSlash(r.root), nth: 1, errno: 'EMFILE' }),
  },
];

/** The fault session's root, in the one form both halves hand the injector. */
const withinOf = (r: CaseRoot): string => toForwardSlash(r.root);

interface Verdict {
  exit: number;
  refusal: string | undefined;
}

/** The case's fixture at a fresh root, with the environment handed back: the spawned run gets its own. */
function fixtureAt(c: VerbCase): CaseRoot {
  const r = makeCaseRoot(scratch.createTempDir());
  try {
    c.fixture(r);
  } finally {
    vi.unstubAllEnvs();
  }
  return r;
}

/** Run the real binary under the preload, in the case's own trees, and read its first document. */
async function spawned(smoke: Smoke): Promise<Verdict & { message: string }> {
  const r = fixtureAt(smoke.c);
  const spec: FaultFsSpec = { within: withinOf(r), faults: [smoke.fault(r)] };
  const result = await executeCli(binPath, [...smoke.command, ...smoke.c.argv(r)], {
    cwd: smoke.c.cwd?.(r) ?? r.project,
    nodeArgs: ['--import', preload],
    env: {
      HOME: r.home, USERPROFILE: r.home, TMPDIR: r.tmp, TEMP: r.tmp, TMP: r.tmp,
      CLAUDE_CONFIG_DIR: '', VAT_CACHE: '0', VAT_FAULT_FS: JSON.stringify(spec),
    },
  });
  const [first] = YAML.parseAllDocuments(result.stdout);
  const report = (first?.toJS() ?? {}) as { error?: { code?: string; message?: string } };
  return { exit: result.status ?? -1, refusal: report.error?.code, message: `${report.error?.message ?? ''}\n${result.stderr}` };
}

describe('fault matrix: the spawned binary agrees with the in-process run', () => {
  it.each(SMOKES)('$name', async (smoke) => {
    const inProcess = await runOnce(smoke.c, scratch.createTempDir(), (r) => installFaultFs({ within: withinOf(r), faults: [faultRuleOf(smoke.fault(r))] }));
    // The in-process half fired its fault, and refused: an agreement between two unfaulted runs would prove nothing.
    expect(inProcess.session.fired).toHaveLength(1);
    const expected: Verdict = { exit: inProcess.outcome.exitCode ?? 0, refusal: inProcess.outcome.refusal };
    expect(expected.exit).not.toBe(0);

    const actual = await spawned(smoke);

    // The preload fired too: the injected errno reached the spawned run's refusal, classified — the refusal
    // names the errno it classified (`(ENOSPC)`), never node's raw message text, which it drops by design.
    expect(actual.message).toContain(`(${smoke.fault(inProcess.r).errno})`);
    expect({ exit: actual.exit, refusal: actual.refusal }).toEqual(expected);
  });
});
