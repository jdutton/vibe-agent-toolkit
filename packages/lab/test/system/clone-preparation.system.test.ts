/**
 * `prepareClone` over real git: the timed arms run in a `git clone --local` of
 * the subject at the measured commit, prepared by untimed exit-checked
 * prerequisites and one warm-up snapshot in its own scratch arm — and proven back
 * at the committed tree before round 1.
 *
 * System-tier: real git, real child processes.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { prepareClone, type ClonePreparation } from '../../src/harness/clone.js';
import type { SequenceStep } from '../../src/harness/sequence.js';
import { argsOf, cleanupProbes, probeStep, readProbeLog, setupProbe, type Probe } from '../command-probe.js';
import { commitAll, git, initRepo, writeFixtureFile } from '../git-fixtures.js';

const scratch: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
});

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
function nodeStep(name: string, script: string): SequenceStep {
  return {
    name,
    command: { kind: 'tool', command: process.execPath, args: ['-e', script] },
    timed: false,
    expectedExit: 0,
    provenance: 'none',
    populates: false,
  };
}

/** A preparation request; the arms root is fresh per call. */
function preparation(source: string, probe: Probe, overrides: Partial<ClonePreparation> = {}): ClonePreparation {
  const armsRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-clone-arms-'));
  scratch.push(armsRoot);
  return {
    source,
    commit: 'HEAD',
    armsRoot,
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
    expect(prepared.path).toBe(safePath.join(request.armsRoot, 'clone'));
    expect(argsOf(readProbeLog(prepared.path))).toEqual([['warmup']]);
    expect(prepared.commit).toMatch(/^[\da-f]{40}$/u);
    expect(prepared.tree).toMatch(/^[\da-f]{40}$/u);
    // The warm-up ran with a store directory of its own (set, not yet created)
    // under the arms root, never the default store.
    expect(readProbeLog(prepared.path)[0]?.storeExisted).toBe(false);
    expect(existsSync(safePath.join(request.armsRoot, 'prepare-warmup-cold', 'tmp'))).toBe(true);

    // Preparation starts from nothing: a second one over the same arms root refuses.
    const again = await prepareClone(request);
    expect(again.ok ? '' : again.refusal).toMatch(/already exists/u);
  });

  it('records what the prerequisites ran without, apart from what the warm-up and git ran without', async () => {
    // Both kinds lose every inherited VAT_* name; only the warm-up (a VAT step)
    // also loses the XDG, temp, Claude and git-config state. The report must say
    // which list is which, not one list for both.
    vi.stubEnv('VAT_LAB_PREPARE_PLANTED', 'leak');
    vi.stubEnv('XDG_CONFIG_HOME', safePath.join(normalizedTmpdir(), 'lab-clone-planted-xdg'));
    const source = subject();
    const probe = setupProbe('lab-clone-probe-');

    const prepared = await prepareClone(preparation(source, probe));

    if (!prepared.ok) throw new Error(prepared.refusal);
    expect(prepared.removedToolEnv).toContain('VAT_LAB_PREPARE_PLANTED');
    expect(prepared.removedToolEnv).not.toContain('XDG_CONFIG_HOME');
    expect(prepared.removedEnv).toEqual(expect.arrayContaining(['VAT_LAB_PREPARE_PLANTED', 'XDG_CONFIG_HOME']));
  });

  it('fails the preparation when a prerequisite exits otherwise than committed', async () => {
    const source = subject();
    const probe = setupProbe('lab-clone-probe-');

    const request = preparation(source, probe, { prerequisites: [nodeStep('install', 'process.exit(1)')] });

    const prepared = await prepareClone(request);

    expect(prepared.ok ? '' : prepared.refusal).toMatch(/step 'install' exited 1/u);
    // The warm-up never ran: the sequence stops at the first unexpected exit.
    expect(readProbeLog(safePath.join(request.armsRoot, 'clone'))).toEqual([]);
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

  it('runs every preparation git without the developer’s global config, so a file only it excludes FAILS the proof', async () => {
    const source = subject();
    const probe = setupProbe('lab-clone-probe-');
    // The developer's global config excludes a file the arms' git (an empty arm
    // home, as on CI) does not: a proof run under it would certify a tree the
    // arms never see.
    const developer = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-clone-home-'));
    scratch.push(developer);
    const excludes = safePath.join(developer, 'global-ignore');
    writeFileSync(excludes, 'globally-excluded.txt\n');
    writeFileSync(safePath.join(developer, '.gitconfig'), `[core]\n\texcludesFile = ${excludes}\n`);
    vi.stubEnv('HOME', developer);
    vi.stubEnv('XDG_CONFIG_HOME', developer);

    const prepared = await prepareClone(
      preparation(source, probe, {
        prerequisites: [nodeStep('build', "require('node:fs').writeFileSync('globally-excluded.txt', 'x')")],
      }),
    );

    expect(prepared.ok ? '' : prepared.refusal).toMatch(/not at the committed tree.*globally-excluded\.txt/su);
  });

  it('records the inherited names the preparation’s git and warm-up ran without', async () => {
    const source = subject();
    const probe = setupProbe('lab-clone-probe-');
    vi.stubEnv('VAT_LAB_PREPARE_PLANTED', 'x');

    const prepared = await prepareClone(preparation(source, probe));

    if (!prepared.ok) throw new Error(prepared.refusal);
    expect(prepared.removedEnv).toContain('VAT_LAB_PREPARE_PLANTED');
    expect(prepared.removedEnv).not.toContain('HOME');
  });

  it('proves a clone whose commit TRACKS a file its .gitignore matches — the snapshot starts from the commit, not an empty index', async () => {
    const source = subject();
    writeFixtureFile(source, '.gitignore', 'built.txt\nprobe.log\nvendored.txt\n');
    writeFixtureFile(source, 'vendored.txt', 'tracked though ignored\n');
    git(['add', '--force', 'vendored.txt'], source);
    commitAll(source, 'vendor a file the ignore rules match');
    const probe = setupProbe('lab-clone-probe-');

    const prepared = await prepareClone(preparation(source, probe));

    expect(prepared.ok ? '' : prepared.refusal).toBe('');
  });

  it('refuses a clone git status calls clean whose snapshot differs — a prerequisite hid a change behind assume-unchanged', async () => {
    const source = subject();
    const probe = setupProbe('lab-clone-probe-');
    const hide: SequenceStep = {
      name: 'hide',
      command: { kind: 'tool', command: gitExecutable(), args: ['update-index', '--assume-unchanged', 'README.md'] },
      timed: false,
      expectedExit: 0,
      provenance: 'none',
      populates: false,
    };

    const prepared = await prepareClone(
      preparation(source, probe, {
        prerequisites: [hide, nodeStep('edit', String.raw`require('node:fs').writeFileSync('README.md', '# changed\n')`)],
      }),
    );

    expect(prepared.ok ? '' : prepared.refusal).toMatch(/is not at the committed tree: snapshot [\da-f]{40}, commit tree [\da-f]{40}/u);
  });

  it('refuses an arms root inside the subject, before cloning anything', async () => {
    const source = subject();
    const probe = setupProbe('lab-clone-probe-');
    const armsRoot = safePath.join(source, 'lab-arms');

    const prepared = await prepareClone({ ...preparation(source, probe), armsRoot });

    expect(prepared.ok ? '' : prepared.refusal).toMatch(/inside the subject/u);
    expect(existsSync(armsRoot)).toBe(false);
  });
});
