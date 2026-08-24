import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {  dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = safePath.resolve(__dirname, '../../dist/bin.js');

function runVat(...args: string[]): SpawnSyncReturns<string> {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
  return spawnSync('node', [binPath, ...args], { encoding: 'utf-8' });
}

describe('CLI basics (integration)', () => {
  it('should show version', () => {
    const result = runVat('--version');

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should show help', () => {
    const result = runVat('--help');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('vat');
    expect(result.stdout).toContain('Usage:');
  });

  it('should handle unknown commands', () => {
    const result = runVat('unknown');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown command');
  });
});

/**
 * The lazy dispatcher must model commander's grammar, not just "first token
 * without a dash".
 *
 * Every case below regressed when the CLI started loading only the command it
 * thought was named, and two of them failed with **exit 0** — the wrong
 * document, reported as success, which no exit-code check can catch. That is
 * why each assertion inspects the OUTPUT rather than the status alone.
 *
 * The suite could not have caught these before: every existing `--cwd` test
 * passes an absolute `mkdtemp` path, which can never collide with a command
 * name, so those fixtures cannot distinguish the bug from correct behaviour.
 */
describe('lazy dispatch models the option grammar', () => {
  it('runs the verb when --cwd\'s value happens to be a command name', () => {
    // `--cwd audit` is a directory, not the verb. Positive control first: the
    // same command with a non-colliding directory must behave identically.
    const control = runVat('--cwd', 'docs', 'inventory', '--help');
    const collide = runVat('--cwd', 'audit', 'inventory', '--help');

    expect(control.status).toBe(0);
    expect(control.stdout).toContain('Usage: vat inventory');
    expect(collide.status).toBe(0);
    expect(collide.stdout).toContain('Usage: vat inventory');
  });

  it('does not silently print root help when --cwd collides', () => {
    // The exit-0 failure mode: the user asked for `validate --help` and got the
    // root help page with a success status.
    const result = runVat('--cwd', 'skills', 'validate', '--help');

    expect(result.stdout).toContain('Usage: vat validate');
    expect(result.stdout).not.toMatch(/^Usage: vat \[options] \[command]/m);
  });

  it('lists every command for `--help` placed before a verb', () => {
    // Root help renders when --help precedes the verb, so it must describe the
    // whole CLI. Loading only `audit` produced a one-entry Commands section
    // that exited 0 while misrepresenting the tool's surface.
    const result = runVat('--help', 'audit');

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^ {2}audit\b/m);
    expect(result.stdout).toMatch(/^ {2}inventory\b/m);
    expect(result.stdout).toMatch(/^ {2}verify\b/m);
  });

  it('still scopes help to the verb for `<verb> --help`', () => {
    // The other order must NOT regress into loading everything.
    const result = runVat('audit', '--help');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: vat audit');
  });

  it('lists every command when erroring on an undeclared option before the verb', () => {
    // `--verbose` is not a ROOT option. Commander's `parseOptions` switches its
    // parse destination to `unknown` at the FIRST unrecognised option-shaped
    // token and leaves it there, so the verb after it never reaches `operands`
    // — the run ends in `unknownOption()` + `showHelpAfterError()`, i.e. ROOT
    // help. Scanning argv for "the first token without a dash" still picked
    // `audit`, so that help page was rendered from a program with exactly one
    // command registered and told the user the CLI has one command.
    const result = runVat('--verbose', 'audit');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--verbose'");
    // Two distinct non-audit verbs: a one-entry Commands section fails both.
    expect(result.stderr).toMatch(/^ {2}inventory\b/m);
    expect(result.stderr).toMatch(/^ {2}verify\b/m);
  });

  it('lists every command when erroring on a bare `-` operand', () => {
    // Commander's `maybeOption` requires `arg.length > 1`, so a lone `-` is an
    // OPERAND: it reaches the `command:*` handler as an unknown command and
    // renders root help. A scan that skips every token starting with `-` moved
    // past it and loaded whatever followed, so the help naming `-` unknown
    // listed only that one command.
    const result = runVat('-', 'audit');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown command '-'");
    expect(result.stderr).toMatch(/^ {2}inventory\b/m);
    expect(result.stderr).toMatch(/^ {2}verify\b/m);
  });

  it('still scopes help to the verb for a DECLARED option before the verb', () => {
    // Positive control for the two cases above: it proves the fixture can tell
    // "loaded one command" from "loaded everything", so their assertions are
    // not vacuously true of every invocation. `--debug` IS declared on the
    // root, so commander recognises it, the verb reaches `operands`, and the
    // lazy path must survive intact — bailing out on every dashed token would
    // pass the two tests above while silently deleting the startup saving.
    const result = runVat('--debug', 'audit', '--help');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: vat audit');
    expect(result.stdout).not.toMatch(/^ {2}inventory\b/m);
  });

  it('lists every command when erroring on the unregistered -V short flag', () => {
    // `-V` is intentionally not registered. Commander errors and renders help;
    // that help came from a program with zero commands loaded and so claimed
    // the CLI had no subcommands at all.
    const result = runVat('-V');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown option '-V'");
    expect(result.stderr).toMatch(/^ {2}audit\b/m);
    expect(result.stderr).toMatch(/^ {2}verify\b/m);
  });
});

/**
 * A prototype-inherited key is not a command.
 *
 * The lazy command dispatcher looks the requested verb up in a plain object
 * literal, whose prototype is `Object.prototype`. Both `in` and a bare index
 * see through to it, so `vat toString` resolved to `Object.prototype.toString`
 * — a truthy function — which the dispatcher then called and handed to
 * `program.addCommand()`. That throws "Command passed to .addCommand() must
 * have a name", so these verbs crashed with an internal commander error
 * instead of the unknown-command message every other unrecognised verb gets.
 *
 * Each assertion names the verb, so an empty or garbled stderr fails rather
 * than passing by absence, and the second assertion pins the specific crash
 * rather than merely "some non-zero exit" — the buggy build also exited
 * non-zero, so `status !== 0` alone would have been true before the fix too.
 */
describe('prototype-inherited keys are not commands', () => {
  for (const name of ['toString', 'valueOf', 'constructor', 'hasOwnProperty']) {
    it(`rejects \`vat ${name}\` as an unknown command`, () => {
      const result = runVat(name);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`unknown command '${name}'`);
      expect(result.stderr).not.toContain('must have a name');
    });
  }
});

/**
 * Absence pin for the deleted `vat pipeline` verb.
 *
 * `pipeline` was an internal dev instrument that appeared in the DEFAULT
 * `vat --help`, advertising a non-product surface to every adopter. It was
 * deleted from the CLI; the oracles it drove live on as repo test
 * infrastructure, reachable only from tests.
 *
 * Both assertions are written to be falsifiable rather than vacuous:
 *
 * - The help assertion anchors on the command-list entry shape (two-space
 *   indent, then the verb) and is guarded by a positive control on a verb that
 *   IS supposed to be there - so an empty or garbled stdout fails loudly
 *   instead of passing by absence.
 * - The invocation assertion checks the *unknown-command* message, not merely a
 *   non-zero exit. `vat pipeline` with no subcommand ALREADY exited 1 while the
 *   verb existed (Commander prints group help to stderr and exits 1), so
 *   `status !== 0` alone would have been true before the deletion too.
 */
describe('deleted `pipeline` verb (absence pin)', () => {
  it('does not list a pipeline command in `vat --help`', () => {
    const result = runVat('--help');

    expect(result.status).toBe(0);
    // Positive control: the command list is really present in this stdout.
    expect(result.stdout).toMatch(/^ {2}audit\b/m);
    expect(result.stdout).not.toMatch(/^ {2}pipeline\b/m);
  });

  it('rejects `vat pipeline` as an unknown command', () => {
    const result = runVat('pipeline');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown command 'pipeline'");
  });
});
