/**
 * No command in this CLI may declare a VARIADIC option.
 *
 * A variadic option (`--param <values...>`) consumes every following token until
 * the next option-shaped one, so it eats the command's positional argument. On
 * `vat resources query <sql> [path]` that was silent — `--param a docs/` bound
 * `docs/` as a SQL parameter, ran against the repository root, and exited 0
 * calling it a success. On `vat skill test run <skill>` it was loud but still
 * wrong: the subject the operator typed was consumed and the run died reporting
 * the subject missing. Both are in
 * `variadic-option-swallows-positional.test.ts`.
 *
 * Every one of those flags already documented itself as "(repeatable)", so the
 * repeatable single-value form loses nothing: `--param a --param b`.
 *
 * ## Why this test reads SOURCE rather than walking the command tree
 *
 * Walking the tree means calling every command factory, which imports the whole
 * CLI surface — the ~1.6s of module load that lazy loading exists to avoid, and
 * the reason `doctor-command-modules.test.ts` mocks the loader table instead.
 * A source scan sees commands no factory in this file imports, including one
 * added tomorrow, and this defect IS a declaration shape: a guard against the
 * two commands that happened to carry it would not be a guard at all.
 *
 * A variadic POSITIONAL (`.argument('<files...>')`) is a different thing and
 * stays allowed — it is last by construction and swallows nothing. The match
 * below is anchored on the leading `-` that only an option flags string has.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

/** `packages/cli/src`, from this test file. */
const SRC_DIR = safePath.resolve(import.meta.dirname, '../../src');

/**
 * A quoted Commander flags string carrying a variadic value spec.
 *
 * Anchored on the `-` that starts an option's flags string, which is what
 * separates `'--env <pair...>'` from the legitimate `.argument('<files...>')`.
 */
const VARIADIC_OPTION = /(['"`])(--?[^'"`\n]*\.{3}[>\]])\1/g;

function* walkTypeScript(dir: string): Generator<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir descends from this package's own src/
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = safePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTypeScript(full);
    } else if (entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

/**
 * Whether a line is prose rather than code.
 *
 * Comment lines are skipped because the doc comments explaining this very rule
 * quote the banned shape, and a guard that fires on its own explanation gets
 * weakened rather than obeyed. A declaration is never on a line that STARTS
 * with a comment marker, so nothing real hides behind this.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/** Every `file: flags-string` this package declares as a variadic option. */
function findVariadicOptions(): string[] {
  const found: string[] = [];
  for (const file of walkTypeScript(SRC_DIR)) {
    const relative = toForwardSlash(safePath.relative(SRC_DIR, file));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- file came from the walk above
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (isCommentLine(line)) continue;
      for (const match of line.matchAll(VARIADIC_OPTION)) {
        found.push(`${relative}: ${match[2] ?? ''}`);
      }
    }
  }
  return found.sort((left, right) => left.localeCompare(right));
}

describe('CLI option declarations', () => {
  it('declares no variadic option anywhere in the command tree', () => {
    // Listed, not counted: the failure message has to name the flag, because
    // the remedy is per-flag (single value + a repeatable collector).
    expect(findVariadicOptions()).toEqual([]);
  });

  it('still recognises the shape it is guarding against', () => {
    // Without this, a regex that stopped matching anything would report a clean
    // tree forever — the same vacuous-green this whole finding is about.
    const sample = `.option('--param <values...>', 'x').argument('<files...>')`;

    expect([...sample.matchAll(VARIADIC_OPTION)].map((match) => match[2])).toEqual([
      '--param <values...>',
    ]);
  });
});
