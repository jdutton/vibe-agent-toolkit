/**
 * 🔑 A supervised checks child prints no operator notices; the process the operator invoked prints
 * each ONCE.
 *
 * The child reads the same config and keys the same store as the process that spawned it, and its
 * stderr is inherited — so before the rule every notice it printed was a second copy: an unknown
 * config key warned twice per run, the "not inside a readable git repository" store notice twice
 * under `vat validate`. Counted on a config-only root (no git), which is the one tree that earns
 * both notices, under every way the checks run: as `vat validate`'s phase, standalone (supervised),
 * and standalone in process (`--budget 0`).
 */

import { describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { fs, safePath } from './test-common.js';
import { checksPhase, count, type Run, TXT_ROWS, vat, writeConfig } from './test-helpers/checks-phase.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-checks-notices-');

/** The config loader's warning for a key VAT has no field for. */
const UNKNOWN_KEY = 'Ignoring the unknown key(s) and continuing';
/** The projection store's notice for a tree it cannot key. */
const UNKEYABLE = 'not inside a readable git repository';

/** A project root with a config carrying one unknown key, and no git — never committed, never `git init`ed. */
function configOnlyRoot(): string {
  const root = safePath.join(scratch(), 'config-only');
  fs.mkdirSync(safePath.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(safePath.join(root, 'docs', 'a.md'), '# Alpha\n', 'utf-8');
  writeConfig(root, [['quick', TXT_ROWS]], 'notAVatKey: 1\n');
  return root;
}

/**
 * Every way the checks run, and where its population origin is read: under `vat validate` it is
 * the checks phase's data — the positive control that the child ran, so a second copy of each
 * notice had somewhere to come from.
 */
const SURFACES: ReadonlyArray<readonly [string, readonly string[], (run: Run) => unknown]> = [
  ['vat validate', ['validate'], (run) => checksPhase(run).data?.['population']],
  ['vat resources check (supervised)', ['resources', 'check'], (run) => run.data['population']],
  ['vat resources check --budget 0 (in process)', ['resources', 'check', '--budget', '0'], (run) => run.data['population']],
];

describe('the checks child is silent; the invoked process prints each notice once', () => {
  it.each(SURFACES)('%s', (_surface, args, population) => {
    const run = vat(configOnlyRoot(), args);

    expect(population(run), run.stderr).toBe('derived');
    expect(count(run.stderr, UNKNOWN_KEY)).toBe(1);
    expect(count(run.stderr, UNKEYABLE)).toBe(1);
  });
});
