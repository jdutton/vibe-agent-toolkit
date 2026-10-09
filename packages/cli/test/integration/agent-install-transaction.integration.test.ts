/**
 * `vat agent install` and `vat agent uninstall` change the install as ONE tree-change plan:
 * a replacement (a copy, or a `--dev` link) is staged beside the install and swapped in whole,
 * and an uninstall parks the install off its name before removing it. So a failure leaves the
 * previous install as it was, a leftover is a finding the report names, and a removal the OS
 * stops never leaves half an install at the path the user knows.
 *
 * Each case runs the verb in-process (the fault matrix's driver) against its own HOME and TMPDIR,
 * under the in-process fault injector — never against a real `~/.claude`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { installFaultFs, symlinkCapability, type FaultRule } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { INSTALL_FAMILY_SHARDS } from '../fault-matrix/cases/install-family.js';
import type { CaseRoot } from '../fault-matrix/drive.js';
import { runOnce } from '../fault-matrix/matrix.js';
import { cleanupTestTempDir, createTestTempDir } from '../system/test-common.js';

const AGENT = 'fx-agent';
const LEFTOVER = 'TREE_CLEANUP_INCOMPLETE';

const installPathOf = (r: CaseRoot): string => safePath.join(r.home, '.claude', 'skills', AGENT);
const isParked = (path: string): boolean => path.endsWith('.previous');

/** Every attempt the primitive makes at removing a parked entry, refused with `errno`. */
function parkedRemovalRefused(errno: FaultRule['errno']): FaultRule[] {
  return [
    { family: 'remove', op: 'rm', path: isParked, nth: 1, errno },
    { family: 'remove', op: 'rm', path: isParked, nth: 2, errno },
    { family: 'remove', op: 'rmdir', path: isParked, nth: 1, errno },
  ];
}

/** Run one install-family case under `faults`, in a fresh root. */
function run(base: string, id: keyof typeof INSTALL_FAMILY_SHARDS, faults: readonly FaultRule[]) {
  return runOnce(INSTALL_FAMILY_SHARDS[id].make(), base, (r) => installFaultFs({ within: r.root, faults: [...faults] }));
}

describe('agent install / uninstall — one plan per install (integration)', () => {
  let base: string;

  afterEach(() => {
    cleanupTestTempDir(base);
  });

  // `--dev` is refused on win32 before anything is examined.
  it.skipIf(symlinkCapability() === null || process.platform === 'win32')('--dev --force whose link cannot be made leaves the previous install as it was', async () => {
    base = createTestTempDir('vat-agent-txn-');
    const { r, outcome } = await run(base, 'agent/install/dev/force', [{ family: 'create', op: 'symlink', path: () => true, errno: 'EACCES' }]);

    expect(outcome.refusal).toBe('RUN_INCOMPLETE');
    expect(outcome.claimsFinished).toBe(false);
    // The prior copy is still the install: nothing removed it before the link failed.
    expect(readFileSync(safePath.join(installPathOf(r), 'SKILL.md'), 'utf8')).toContain('0.9.0');
  });

  it('a replaced install the OS will not let VAT remove is a finding naming it, on a run that finished', async () => {
    base = createTestTempDir('vat-agent-txn-');
    const { r, outcome } = await run(base, 'agent/install/copy/force', parkedRemovalRefused('EBUSY'));

    expect(outcome.exitCode ?? 0).toBe(0);
    const leftover = outcome.findings?.find((finding) => finding.code === LEFTOVER);
    expect(leftover?.path, JSON.stringify(outcome.findings)).toMatch(/\.previous$/);
    expect(readFileSync(safePath.join(installPathOf(r), 'SKILL.md'), 'utf8')).not.toContain('0.9.0');
  });

  it('a refused fresh install leaves no ~/.claude directories it made', async () => {
    base = createTestTempDir('vat-agent-txn-');
    const { r, outcome } = await run(base, 'agent/install/copy/fresh', [{ family: 'create', op: 'mkdtemp', path: () => true, errno: 'EACCES' }]);

    expect(outcome.refusal).toBe('RUN_INCOMPLETE');
    expect(existsSync(safePath.join(r.home, '.claude'))).toBe(false);
  });

  it('an uninstall the OS stops after the install left its path is RUN_INCOMPLETE, the removal published and the parked install named', async () => {
    base = createTestTempDir('vat-agent-txn-');
    const { r, outcome } = await run(base, 'agent/uninstall/copy', parkedRemovalRefused('EBUSY'));

    expect(outcome.refusal).toBe('RUN_INCOMPLETE');
    expect(outcome.message).toMatch(/\.previous/);
    // The removal is done (off its path): the refusal says so, beside the warning naming what is left.
    expect(outcome.claimsFinished).toBe(true);
    expect(outcome.findings?.find((finding) => finding.code === LEFTOVER)?.path).toMatch(/\.previous$/);
    expect(existsSync(installPathOf(r))).toBe(false);
    // The install is whole under its parked name: the message names where it is.
    const skills = safePath.join(r.home, '.claude', 'skills');
    const parked = readdirSync(skills).find((name) => isParked(name));
    expect(parked).toBeDefined();
    expect(readdirSync(safePath.join(skills, parked ?? ''))).toEqual(['SKILL.md']);
  });

  it('an install over an existing one without --force is USAGE_INVALID saying how to proceed, and changes nothing', async () => {
    base = createTestTempDir('vat-agent-txn-');
    const c = INSTALL_FAMILY_SHARDS['agent/install/copy/force'].make();
    const { r, outcome } = await runOnce({ ...c, argv: () => ['install', AGENT] }, base, (root) => installFaultFs({ within: root.root, faults: [] }));

    expect(outcome.refusal).toBe('USAGE_INVALID');
    expect(outcome.message).toContain('--force');
    expect(readFileSync(safePath.join(installPathOf(r), 'SKILL.md'), 'utf8')).toContain('0.9.0');
  });
});
