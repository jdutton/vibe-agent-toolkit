/**
 * An arm runs the REAL vat build from an environment cleared of the developer's
 * VAT, git and Claude state. Each case plants that state in the parent, proves
 * with a control that the plant reaches an un-cleared vat, then shows the arm
 * never sees it:
 *
 * - `VAT_PROJECTION_STORE=off` would stop the store being written; the cold rule
 *   then asserts the arm's store is non-empty after step 1.
 * - A global git exclude via `XDG_CONFIG_HOME` hides an untracked file from
 *   git's enumeration; the arm still admits it.
 * - A planted `~/.claude/CLAUDE.md`, reached through the project's `@~/` import,
 *   is what `claude context` resolves under the developer's home; the arm
 *   resolves it under its own, empty home.
 *
 * System-tier: real git, the built vat at `packages/cli/dist/bin/vat.js`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

import { normalizedTmpdir, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { runRepeats } from '../../src/harness/repeat.js';
import type { SequenceStep } from '../../src/harness/sequence.js';
import type { ResolvedInstrument } from '../../src/harness/types.js';
import { PROBE_VERSION } from '../command-probe.js';
import { commitAll, initRepo, writeFixtureFile } from '../git-fixtures.js';

const VAT_BIN = resolveFromImportMeta(import.meta.url, '../../../cli/dist/bin/vat.js');
const VAT: ResolvedInstrument = { command: process.execPath, leadingArgs: [VAT_BIN], version: PROBE_VERSION };

const SCAN = ['resources', 'scan', '.', '--verbose', '--format', 'json'];
// One path, not `--all`: the single-path answer names each import's resolved target.
const CONTEXT = ['claude', 'context', 'docs/tracked.md', '--format', 'json'];

const scratch: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A fresh scratch directory, dropped after the suite. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A committed subject importing the user's memory, one tracked doc and one UNTRACKED doc. */
function subject(): string {
  const root = tempDir('lab-arm-isolation-subject-');
  initRepo(root);
  writeFixtureFile(root, 'CLAUDE.md', '# project\n\n@~/.claude/CLAUDE.md\n');
  writeFixtureFile(root, 'docs/tracked.md', '# tracked\n');
  commitAll(root, 'subject');
  writeFixtureFile(root, 'docs/excluded.md', '# untracked, globally excluded in the parent\n');
  return root;
}

/** A timed VAT step committed to exit 0. */
function vatStep(name: string, args: readonly string[], overrides: Partial<SequenceStep> = {}): SequenceStep {
  return { name, command: { kind: 'vat', args }, timed: true, expectedExits: [0], provenance: 'none', populates: false, ...overrides };
}

/**
 * Plant the developer state in THIS process's environment (stubbed, restored after each case).
 *
 * @returns The planted home
 */
function plantDeveloperState(): string {
  const xdg = tempDir('lab-arm-isolation-xdg-');
  writeFixtureFile(xdg, 'git/ignore', 'excluded.md\n');
  const home = tempDir('lab-arm-isolation-home-');
  writeFixtureFile(home, '.claude/CLAUDE.md', '# planted user memory\n');
  vi.stubEnv('VAT_PROJECTION_STORE', 'off');
  vi.stubEnv('XDG_CONFIG_HOME', xdg);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', safePath.join(home, '.claude'));
  vi.stubEnv('TMPDIR', tempDir('lab-arm-isolation-tmp-'));
  return home;
}

/**
 * Run vat directly under this process's (planted) environment — the control.
 *
 * @param cwd - The subject
 * @param args - vat's arguments
 * @returns Its stdout
 */
function uncleared(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  return spawnSync(process.execPath, [VAT_BIN, ...args], { cwd, encoding: 'utf-8', env }).stdout;
}

/**
 * @param dir - A projection store directory
 * @returns What it holds; `[]` when it was never made
 */
function storeEntries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('an arm never sees the developer’s VAT, git or Claude state', () => {
  it('CONTROL: the planted exclude and home DO reach an uncleared vat', () => {
    const root = subject();
    const home = plantDeveloperState();

    expect(uncleared(root, SCAN)).not.toContain('excluded.md');
    expect(uncleared(root, CONTEXT)).toContain(`${basename(home)}/.claude/CLAUDE.md`);
  });

  it('CONTROL: the planted VAT_PROJECTION_STORE=off DOES stop an uncleared vat writing its store', () => {
    const root = subject();
    plantDeveloperState();
    const off = safePath.join(tempDir('lab-arm-isolation-store-'), 'store');
    const on = safePath.join(tempDir('lab-arm-isolation-store-'), 'store');

    uncleared(root, ['resources', 'validate'], { ...process.env, VAT_PROJECTION_STORE_DIR: off });
    const unplanted = { ...process.env };
    delete unplanted['VAT_PROJECTION_STORE'];
    uncleared(root, ['resources', 'validate'], { ...unplanted, VAT_PROJECTION_STORE_DIR: on });

    // The twin without the plant writes one, so an empty `off` is the plant's doing.
    expect(storeEntries(off)).toEqual([]);
    expect(storeEntries(on)).not.toEqual([]);
  });

  it('populates its own store despite VAT_PROJECTION_STORE=off, and still admits the globally excluded file', async () => {
    const root = subject();
    plantDeveloperState();

    const run = await runRepeats({
      instrument: VAT,
      cwd: root,
      steps: [vatStep('validate', ['resources', 'validate'], { populates: true }), vatStep('scan', SCAN)],
      runs: 1,
      arm: { out: tempDir('lab-arm-isolation-out-'), build: 'cli', arm: 'isolation', state: 'cold' },
      env: { set: {}, unset: [] },
    });

    const [repetition] = run.results;
    // The cold rule passed: step 1 left the store non-empty and a parse shard.
    expect(repetition?.violation ?? null).toBeNull();
    expect(repetition?.steps[1]?.stdout).toContain('docs/excluded.md');
    // Removed, not re-pointed: the arm sets its own TMPDIR, HOME and CLAUDE_CONFIG_DIR.
    expect(run.removed).toEqual(expect.arrayContaining(['VAT_PROJECTION_STORE', 'XDG_CONFIG_HOME']));
  });

  it('resolves ~/ under its own empty home, never the planted one', async () => {
    const root = subject();
    const home = plantDeveloperState();

    const run = await runRepeats({
      instrument: VAT,
      cwd: root,
      steps: [vatStep('context', CONTEXT)],
      runs: 1,
      arm: { out: tempDir('lab-arm-isolation-out-'), build: 'cli', arm: 'context', state: 'cold' },
      env: { set: {}, unset: [] },
    });

    const stdout = run.results[0]?.stdout ?? '';
    expect(run.results[0]?.violation ?? null).toBeNull();
    expect(stdout).toContain('arms/cli-context-cold/home/.claude/CLAUDE.md');
    expect(stdout).not.toContain(basename(home));
  });
});
