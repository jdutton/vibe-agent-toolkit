/**
 * A VARIADIC option and a positional argument cannot coexist — the option eats
 * the positional, and on `vat resources query` it does so at exit 0.
 *
 * Commander collects a variadic option's values until the next option-shaped
 * token, so a trailing positional is indistinguishable from one more value:
 *
 *     vat resources query 'SELECT ? AS x, ? AS y' --param a docs/
 *
 * reported `status: success` with `y: 'docs/'` in its rows: the token the
 * operator typed as the `[path]` positional was bound as the SECOND SQL VALUE,
 * and the positional itself was never read. Nothing in the document says a
 * location was reinterpreted as data.
 *
 * ⚠️ These tests pin the PARSE — that commander hands the token to the operand
 * slot and not to the option — and nothing more. What `query` does with a
 * `[path]` (locates the project; never scopes) is `queryCommand`'s contract and
 * is pinned by `test/system/resources-query.system.test.ts` through the real
 * command. Do not read "the corpus the user named" below as a scoping claim.
 *
 * The fix is the repeatable single-value form (`--param a --param b`), which is
 * what every one of these flags' help text already CLAIMED to be. The source
 * sweep in `no-variadic-cli-options.test.ts` is the part that keeps it fixed:
 * this defect is a declaration shape, so the guard has to be against the shape,
 * not against the two commands that happened to carry it.
 *
 * Pre-1.0, so the space-separated spelling is simply gone — no alias, no shim.
 */

import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { createSkillTestRunCommand } from '../../src/commands/skill/test/run.js';

/** A statement with two placeholders, so a swallowed path binds instead of erroring. */
const TWO_PARAM_SQL = 'SELECT ? AS x, ? AS y';
/** The `[path]` the operator typed — a project locator on `query` — and the token the variadic ate. */
const LOCATOR_PATH = 'docs/';

/** What a displaced action handler saw: the operands, then Commander's option bag. */
interface Invocation {
  readonly operands: readonly unknown[];
  readonly options: Record<string, unknown>;
}

function subcommand(root: Command, name: string): Command {
  const found = root.commands.find((candidate) => candidate.name() === name);
  if (!found) throw new Error(`command factory no longer exposes a '${name}' subcommand`);
  return found;
}

/**
 * Parse a real argv through the real Command and report what the action got.
 *
 * The real handler is displaced (it populates a projection and calls
 * `process.exit`) and `exitOverride` keeps a usage error from killing the run —
 * a swallowed REQUIRED positional surfaces as a thrown CommanderError, which is
 * an outcome these tests need to be able to see rather than die on.
 */
function invoke(root: Command, target: Command, argv: readonly string[]): Invocation {
  let seen: Invocation | undefined;
  root.exitOverride();
  target.exitOverride();
  target.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  target.action((...args: unknown[]) => {
    // Commander appends (options, command) after the declared operands.
    seen = {
      operands: args.slice(0, -2),
      options: (args.at(-2) ?? {}) as Record<string, unknown>,
    };
  });
  root.parse([...argv], { from: 'user' });
  if (!seen) throw new Error('the action never ran');
  return seen;
}

function invokeQuery(argv: readonly string[]): Invocation {
  const root = createResourcesCommand();
  return invoke(root, subcommand(root, 'query'), ['query', ...argv]);
}

describe('vat resources query --param', () => {
  it('leaves the [path] positional alone', () => {
    const { operands, options } = invokeQuery([TWO_PARAM_SQL, '--param', 'a', LOCATOR_PATH]);

    // The whole defect in one assertion: the token reaches the positional.
    expect(operands[1]).toBe(LOCATOR_PATH);
    // ...and it must not ALSO have been bound to the second `?`.
    expect(options['param']).toEqual(['a']);
  });

  it('accumulates a repeated flag, in the order given', () => {
    const { options } = invokeQuery([TWO_PARAM_SQL, '--param', 'a', '--param', 'b']);

    expect(options['param']).toEqual(['a', 'b']);
  });

  it('leaves param undefined when the flag is absent', () => {
    // Not `[]`: a shared default array is a cross-invocation leak, and the
    // read site already spells its own "no parameters" fallback.
    const { options } = invokeQuery([TWO_PARAM_SQL]);

    expect(options['param']).toBeUndefined();
  });
});

describe('vat skill test run repeatable flags', () => {
  it.each([
    { flag: '--with', key: 'with', value: 'helper=npm:@scope/s@1.2.3' },
    { flag: '--with-optional', key: 'withOptional', value: 'extra=vendored' },
    { flag: '--env', key: 'env', value: 'KEY=VALUE' },
    { flag: '--pass-env', key: 'passEnv', value: 'HOME' },
  ])('$flag leaves the <skill> positional alone', ({ flag, key, value }) => {
    const command = createSkillTestRunCommand();
    // The subject AFTER the flag: the order an operator naturally types, and the
    // order in which the variadic form consumed it and then reported the subject
    // missing.
    const { operands, options } = invoke(command, command, [flag, value, 'skills/demo']);

    expect(operands[0]).toBe('skills/demo');
    expect(options[key]).toEqual([value]);
  });
});
