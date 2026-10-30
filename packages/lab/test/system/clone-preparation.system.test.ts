/**
 * `prepareClone` over real git: the timed arms run in a `git clone --local` of
 * the subject at the measured commit, prepared by untimed exit-checked
 * prerequisites and one warm-up snapshot in its own scratch arm — and proven back
 * at the committed tree before round 1.
 *
 * Integration-tier: real git, real child processes.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { prepareClone, type ClonePreparation } from '../../src/harness/clone.js';
import type { SequenceStep } from '../../src/harness/sequence.js';
import { argsOf, cleanupProbes, probeStep, readProbeLog, setupProbe, type Probe } from '../command-probe.js';
import { commitAll, initRepo, writeFixtureFile } from '../git-fixtures.js';

const scratch: string[] = [];

afterAll(() => {
  cleanupProbes();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A committed subject whose `.gitignore` covers what the steps below write. */
function subject(): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-clone-subject-'));
  scratch.push(root);
  initRepo(root);
  writeFixtureFile(root, '.gitignore', 'built.txt\nprobe.log\n');
  writeFixtureFile(root, 'README.md', '# committed\n');
  commitAll(root, 'subject');
  return root;
}

/** An untimed tool step running `node -e <script>` in the clone. */
function nodeStep(name: string, script: string, expectedExits: readonly number[] = [0]): SequenceStep {
  return {
    name,
    command: { kind: 'tool', command: process.execPath, args: ['-e', script] },
    timed: false,
    expectedExits,
    provenance: 'none',
    populates: false,
  };
}

/** A preparation request; the out directory is fresh per call. */
function preparation(source: string, probe: Probe, overrides: Partial<ClonePreparation> = {}): ClonePreparation {
  const out = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-clone-out-'));
  scratch.push(out);
  return {
    source,
    commit: 'HEAD',
    out,
    prerequisites: [nodeStep('build', "require('node:fs').writeFileSync('built.txt', 'x')")],
    warmup: { instrument: probe.instrument, step: probeStep(['warmup'], { timed: false }) },
    ...overrides,
  };
}

describe('prepareClone', () => {
  it('clones the COMMITTED tree, runs the prerequisites then a scratch-arm warm-up, and proves it clean', async () => {
    const source = subject();
    // Uncommitted state in the subject must not reach the clone.
    writeFixtureFile(source, 'README.md', '# dirty working tree\n');
    const probe = setupProbe('lab-clone-probe-');

    const request = preparation(source, probe);

    const prepared = await prepareClone(request);

    if (!prepared.ok) throw new Error(prepared.refusal);
    expect(readFileSync(safePath.join(prepared.path, 'README.md'), 'utf8')).toBe('# committed\n');
    expect(existsSync(safePath.join(prepared.path, 'built.txt'))).toBe(true);
    expect(prepared.path).toBe(safePath.join(request.out, 'clone'));
    expect(argsOf(readProbeLog(prepared.path))).toEqual([['warmup']]);
    expect(prepared.commit).toMatch(/^[\da-f]{40}$/u);
    expect(prepared.tree).toMatch(/^[\da-f]{40}$/u);
    // The warm-up ran with a store directory of its own (set, not yet created)
    // under <out>/arms, never the default store.
    expect(readProbeLog(prepared.path)[0]?.storeExisted).toBe(false);
    expect(existsSync(safePath.join(request.out, 'arms', 'prepare-warmup-cold', 'tmp'))).toBe(true);

    // Preparation starts from nothing: a second one over the same out refuses.
    const again = await prepareClone(request);
    expect(again.ok ? '' : again.refusal).toMatch(/already exists/u);
  });

  it('fails the preparation when a prerequisite exits otherwise than committed', async () => {
    const source = subject();
    const probe = setupProbe('lab-clone-probe-');

    const request = preparation(source, probe, { prerequisites: [nodeStep('install', 'process.exit(1)')] });

    const prepared = await prepareClone(request);

    expect(prepared.ok ? '' : prepared.refusal).toMatch(/step 'install' exited 1/u);
    // The warm-up never ran: the sequence stops at the first unexpected exit.
    expect(readProbeLog(safePath.join(request.out, 'clone'))).toEqual([]);
  });

  it('fails the preparation, naming the path, when a step leaves a non-ignored file', async () => {
    const source = subject();
    const probe = setupProbe('lab-clone-probe-');

    const prepared = await prepareClone(
      preparation(source, probe, {
        prerequisites: [nodeStep('build', "require('node:fs').writeFileSync('stray.txt', 'x')")],
      }),
    );

    expect(prepared.ok).toBe(false);
    expect(prepared.ok ? '' : prepared.refusal).toMatch(/not at the committed tree.*stray\.txt/su);
  });
});
