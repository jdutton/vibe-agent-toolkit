/**
 * Every command that offers `--format` must publish its FAILURE in that format.
 *
 * ## The defect
 *
 * `handleCommandError` grew a `format` parameter whose docstring says *"a caller
 * that has a `--format` option MUST pass it"*, and the change that added it
 * threaded the argument into six call sites while missing two commands the same
 * change created — `vat claude budget` and `vat claude context`. A third lane,
 * `finishCommand`, hardcoded `writeYamlOutput` for its failed arm, which is
 * `vat resources validate`'s only error exit. So on the one path a scripted
 * consumer most needs to parse, `--format json` silently produced YAML.
 *
 * ## Why the last case here is a source scan and not a behaviour test
 *
 * A docstring saying MUST is exactly the mechanism that failed: nothing read it,
 * so a command added later drops the argument again and every behaviour test
 * above stays green because it names the commands that exist today. The
 * `finishCommand` half is closed by the type system — its `format` parameter is
 * REQUIRED, so a new caller cannot forget it. `handleCommandError` has eighteen
 * call sites and cannot be made required without touching all of them, so the
 * obligation is enforced here instead: a file that reads `options.format` and
 * calls `handleCommandError` must pass the fifth argument.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeBudgetCommand } from '../../src/commands/claude/budget.js';
import { claudeContextCommand } from '../../src/commands/claude/context.js';
import { finishCommand } from '../../src/commands/phase-utils.js';

/** What the mocked `process.exit` throws, so the caller unwinds instead of dying. */
const PROCESS_EXIT_ERROR_MESSAGE = 'process.exit called';

/**
 * A path argument that resolves outside any discovered corpus root.
 *
 * The cheapest reachable throw in both commands: `targetPathWithin` refuses it
 * BEFORE the projection is populated, which is the whole reason the guard runs
 * first. A test that had to build a population to reach the catch arm would cost
 * minutes and measure the population instead of the format.
 */
const OUTSIDE_ROOT = '/';

/** The CLI source tree the last case scans. */
const CLI_SRC = safePath.resolve(import.meta.dirname, '../../src');

/** Reads the `--format` document-serialization option — and NOT `--formats`. */
const READS_FORMAT_OPTION = /options\.format(?!\w)/;

describe('a failing command honours the --format it was given', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error(PROCESS_EXIT_ERROR_MESSAGE);
    }) as unknown as ReturnType<typeof vi.spyOn>;
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((): boolean => true) as unknown as ReturnType<typeof vi.spyOn>;
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((): boolean => true) as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  /** Everything the command wrote to stdout, joined. */
  const publishedDocument = (): string =>
    stdoutSpy.mock.calls.map((call) => String(call[0])).join('');

  it('publishes `vat claude budget --format json` failures as JSON', async () => {
    await expect(
      claudeBudgetCommand([OUTSIDE_ROOT], { format: 'json' }),
    ).rejects.toThrow(PROCESS_EXIT_ERROR_MESSAGE);

    // Parses as JSON, which is the claim — not merely "contains a brace".
    const parsed = JSON.parse(publishedDocument()) as { status: string; error: string };
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('outside the corpus root');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('publishes `vat claude context --format json` failures as JSON', async () => {
    await expect(
      claudeContextCommand([OUTSIDE_ROOT], { format: 'json' }),
    ).rejects.toThrow(PROCESS_EXIT_ERROR_MESSAGE);

    const parsed = JSON.parse(publishedDocument()) as { status: string; error: string };
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('outside the corpus root');
  });

  it('keeps YAML for those commands at their `text` default', () => {
    // The control. A format switch asserted only from the JSON side is also
    // satisfied by one that emits JSON unconditionally — which would break
    // every default, human-facing run.
    expect(() => finishCommand({ document: { status: 'error' }, exitCode: 2, failed: true },
      () => undefined, 'text')).toThrow(PROCESS_EXIT_ERROR_MESSAGE);
    expect(publishedDocument()).toContain('status: error');
  });

  it('publishes the `finishCommand` failed arm as JSON when asked', () => {
    // `vat resources validate`'s ONLY error exit. It hardcoded `writeYamlOutput`.
    expect(() => finishCommand(
      { document: { status: 'error', error: 'Boom' }, exitCode: 2, failed: true },
      () => undefined,
      'json',
    )).toThrow(PROCESS_EXIT_ERROR_MESSAGE);

    const parsed = JSON.parse(publishedDocument()) as { status: string; error: string };
    expect(parsed).toEqual({ status: 'error', error: 'Boom' });
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('leaves a command\'s OWN report to its own renderer, whatever the format', () => {
    // The other control: `format` governs the failure envelope only. A success
    // document still goes through `render`, or `--format text` would lose the
    // human rendering it exists for.
    const rendered: unknown[] = [];
    expect(() => finishCommand({ document: { ok: true }, exitCode: 0 },
      (document) => rendered.push(document), 'json')).toThrow(PROCESS_EXIT_ERROR_MESSAGE);
    expect(rendered).toEqual([{ ok: true }]);
    expect(publishedDocument()).toBe('');
  });
});

describe('every handleCommandError caller that has a --format passes it', () => {
  it('finds no call site that drops the format its command accepts', () => {
    const offenders: string[] = [];
    for (const file of typeScriptFilesUnder(CLI_SRC)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- walking this package's own src tree
      const source = readFileSync(file, 'utf8');
      if (!source.includes('handleCommandError(')) continue;
      // The command reads a `--format` option, so its failure document has a
      // format to honour. A file that never reads one has nothing to pass.
      //
      // 🪤 The lookahead is load-bearing: `vat skills package` reads
      // `options.formatS` — the artifact kinds it produces (directory, zip,
      // npm), not a document serialization — and a prefix match files it as an
      // offender for a flag it does not have.
      if (!READS_FORMAT_OPTION.test(source)) continue;
      if (callsMissingFormatArgument(source).length > 0) {
        offenders.push(safePath.relative(CLI_SRC, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Every `handleCommandError(...)` invocation in `source` that passes fewer than
 * five arguments.
 *
 * Import lines and doc comments name the function without calling it, so the
 * match requires an open parenthesis AND is measured to its closing one; the
 * argument list here is always flat (identifiers and string literals), so a
 * comma count is exact.
 *
 * @param source - One module's text
 * @returns The offending call texts, empty when every call carries a format
 */
function callsMissingFormatArgument(source: string): string[] {
  const offenders: string[] = [];
  const pattern = /handleCommandError\(([^)]*)\)/g;
  for (const match of source.matchAll(pattern)) {
    const argumentList = match[1] ?? '';
    // A doc-comment mention such as `{@link handleCommandError}` has no args.
    if (argumentList.trim() === '') continue;
    if (argumentList.split(',').length < 5) offenders.push(match[0]);
  }
  return offenders;
}

/**
 * Every `.ts` file beneath a directory.
 *
 * @param directory - Where to start
 * @returns Absolute paths, in directory order
 */
function typeScriptFilesUnder(directory: string): string[] {
  const found: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- walking this package's own src tree
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = safePath.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...typeScriptFilesUnder(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}
