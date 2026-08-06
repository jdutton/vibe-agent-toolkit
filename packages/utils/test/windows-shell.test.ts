import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveFromImportMeta } from '../src/fs.js';
import { safePath } from '../src/path.js';
import {
  buildWindowsShellLine,
  isPathLike,
  resolveShellCommandToken,
  shouldUseShell,
  windowsShellQuote,
} from '../src/windows-shell.js';

const onWindows = process.platform === 'win32';

// NOTE: `String.raw` cannot express a string ending in a backslash (the backslash escapes
// the closing backtick), and that shape is central to everything below — so these tests use
// ordinary literals with `BS` for ONE literal backslash. Comments give the real values.
const BS = '\\';

// ---------------------------------------------------------------------------
// Reference parser: `CommandLineToArgvW`, the thing that turns the command line back into
// argv inside the launched process. Hand-picked expectations are what let the previous bug
// through — this lets the tests assert a real ROUND TRIP instead of a chosen string.
//
// Rules implemented:
//   - 2n backslashes before a `"`  -> n backslashes, and the quote is a delimiter
//   - 2n+1 backslashes before a `"` -> n backslashes, and the quote is LITERAL
//   - backslashes not before a `"` -> literal, all of them
//   - `""` while inside quotes -> one literal `"` (the CRT's doubled-quote escape)
//   - unquoted whitespace separates arguments; a quote can start an empty argument
// ---------------------------------------------------------------------------
interface ArgvParseState {
  argv: string[];
  current: string;
  started: boolean;
  inQuotes: boolean;
  index: number;
}

function flushArg(state: ArgvParseState): void {
  if (state.started) {
    state.argv.push(state.current);
    state.current = '';
    state.started = false;
  }
}

function consumeQuote(state: ArgvParseState, line: string): void {
  state.started = true; // even `""` alone yields one (empty) argument
  if (state.inQuotes && line.charAt(state.index + 1) === '"') {
    state.current += '"';
    state.index += 2;
    return;
  }
  state.inQuotes = !state.inQuotes;
  state.index += 1;
}

/** Consumes a backslash run. Returns true if a delimiter quote is left to consume. */
function consumeBackslashRun(state: ArgvParseState, line: string): boolean {
  let count = 0;
  while (line.charAt(state.index) === '\\') {
    count += 1;
    state.index += 1;
  }
  state.started = true;
  if (line.charAt(state.index) !== '"') {
    state.current += '\\'.repeat(count);
    return false;
  }
  state.current += '\\'.repeat(Math.floor(count / 2));
  if (count % 2 === 1) {
    state.current += '"';
    state.index += 1;
    return false;
  }
  return true;
}

function commandLineToArgv(line: string): string[] {
  const state: ArgvParseState = { argv: [], current: '', started: false, inQuotes: false, index: 0 };

  while (state.index < line.length) {
    const char = line.charAt(state.index);
    if (!state.inQuotes && (char === ' ' || char === '\t')) {
      flushArg(state);
      state.index += 1;
    } else if (char === '\\') {
      if (consumeBackslashRun(state, line)) {
        consumeQuote(state, line);
      }
    } else if (char === '"') {
      consumeQuote(state, line);
    } else {
      state.current += char;
      state.started = true;
      state.index += 1;
    }
  }

  flushArg(state);
  return state.argv;
}

/** The property every quoted argument must satisfy: it survives, and so does the next arg. */
function roundTrips(arg: string): boolean {
  const parsed = commandLineToArgv(`${windowsShellQuote(arg)} NEXT`);
  return parsed.length === 2 && parsed[0] === arg && parsed[1] === 'NEXT';
}

/** Alphabet for the exhaustive harness: an ordinary char plus every char that matters here. */
const ARG_ALPHABET = ['a', BS, '"', ' ', '%'];
const MAX_ARG_LENGTH = 4;

function allStringsOverAlphabet(maxLength: number): string[] {
  let frontier = [''];
  const all = [''];
  for (let length = 1; length <= maxLength; length += 1) {
    frontier = frontier.flatMap(prefix => ARG_ALPHABET.map(char => prefix + char));
    all.push(...frontier);
  }
  return all;
}

describe('commandLineToArgv (the reference parser these tests are measured against)', () => {
  // Microsoft's own worked examples from "Parsing C Command-Line Arguments". If the
  // reference parser is wrong, every round-trip assertion below is worthless.
  it.each([
    { line: '"a b c" d e', expected: ['a b c', 'd', 'e'] },
    { line: `"ab${BS}"c" "${BS}${BS}" d`, expected: [`ab"c`, BS, 'd'] },
    { line: `a${BS.repeat(3)}b d"e f"g h`, expected: [`a${BS.repeat(3)}b`, 'de fg', 'h'] },
    { line: `a${BS.repeat(3)}"b c d`, expected: [`a${BS}"b`, 'c', 'd'] },
    { line: `a${BS.repeat(4)}"b c" d e`, expected: [`a${BS.repeat(2)}b c`, 'd', 'e'] },
  ])('parses $line', ({ line, expected }) => {
    expect(commandLineToArgv(line)).toEqual(expected);
  });

  it('yields an empty argument for a bare quote pair', () => {
    expect(commandLineToArgv('"" NEXT')).toEqual(['', 'NEXT']);
  });

  it('treats a doubled quote inside quotes as one literal quote', () => {
    expect(commandLineToArgv('"a""b" NEXT')).toEqual(['a"b', 'NEXT']);
  });
});

describe('windowsShellQuote', () => {
  it('leaves a plain token untouched', () => {
    expect(windowsShellQuote('claude')).toBe('claude');
    expect(windowsShellQuote('--version')).toBe('--version');
    expect(windowsShellQuote('C:/tools/x.txt')).toBe('C:/tools/x.txt');
  });

  it('quotes an empty argument (so it survives as a distinct arg)', () => {
    expect(windowsShellQuote('')).toBe('""');
  });

  it('quotes whitespace', () => {
    expect(windowsShellQuote('a b')).toBe('"a b"');
    expect(windowsShellQuote('C:/Program Files/x')).toBe('"C:/Program Files/x"');
  });

  it(`escapes an embedded double quote as ${BS}" (the CommandLineToArgvW escape form)`, () => {
    // NOT the `""` form: see the two-parser note in windows-shell.ts. `\"` is understood
    // identically by every argv parser; `""` is version-dependent in the launched process.
    expect(windowsShellQuote('a"b')).toBe(`"a${BS}"b"`);
    expect(roundTrips('a"b')).toBe(true);
  });

  it.each(['&', '|', '<', '>', '^', '(', ')', '%', '!'])(
    'quotes the cmd.exe metacharacter %s',
    metachar => {
      expect(windowsShellQuote(`a${metachar}b`)).toBe(`"a${metachar}b"`);
    },
  );

  describe('backslash runs (CommandLineToArgvW quote-escaping)', () => {
    it('doubles a single trailing backslash so it cannot escape the closing quote', () => {
      // Naive quoting yields  "C:\Program Files\"  — the \ escapes the terminator and the
      // argument swallows whatever follows it. Correct is  "C:\Program Files\\"
      expect(windowsShellQuote(`C:${BS}Program Files${BS}`)).toBe(
        `"C:${BS}Program Files${BS}${BS}"`,
      );
    });

    it('doubles a run of two trailing backslashes into four', () => {
      // in:  C:\Program Files\\        out:  "C:\Program Files\\\\"
      expect(windowsShellQuote(`C:${BS}Program Files${BS}${BS}`)).toBe(
        `"C:${BS}Program Files${BS.repeat(4)}"`,
      );
    });

    it('doubles a longer run, and terminates when the arg is nothing but backslashes', () => {
      // in:  x \\\           out:  "x \\\\\\"
      expect(windowsShellQuote(`x ${BS.repeat(3)}`)).toBe(`"x ${BS.repeat(6)}"`);
      // The scan walks off the front here rather than finding a non-backslash.
      expect(windowsShellQuote(` ${BS.repeat(2)}`)).toBe(`" ${BS.repeat(4)}"`);
    });

    it('leaves a trailing backslash alone when nothing triggers quoting', () => {
      // No whitespace/metachar => unquoted => there is no terminator to protect, and
      // doubling here would corrupt the path.
      expect(windowsShellQuote(`C:${BS}Tools${BS}`)).toBe(`C:${BS}Tools${BS}`);
      expect(windowsShellQuote(BS)).toBe(BS);
    });

    it('leaves an interior backslash run untouched when no quote follows it', () => {
      // in:  C:\Program Files\app.exe   out:  "C:\Program Files\app.exe"
      expect(windowsShellQuote(`C:${BS}Program Files${BS}app.exe`)).toBe(
        `"C:${BS}Program Files${BS}app.exe"`,
      );
    });

    it('doubles an INTERIOR run that precedes a quote (the bug this replaced)', () => {
      // in:  a\"b     out:  "a\\\"b"   — 2n backslashes for the literal `\`, +1 escaping
      // the quote. The old code doubled only the trailing run, so the `\` here escaped the
      // first half of its `""` pair and the parse desynchronized from that point on.
      expect(windowsShellQuote(`a${BS}"b`)).toBe(`"a${BS.repeat(3)}"b"`);
    });

    it('escapes an embedded quote alongside a trailing backslash', () => {
      // in:  a"b\        out:  "a\"b\\"
      expect(windowsShellQuote(`a"b${BS}`)).toBe(`"a${BS}"b${BS.repeat(2)}"`);
    });
  });

  // The hand-picked cases above are exactly what let the previous defect through: each one
  // asserted a chosen output rather than the property that actually matters. This is the
  // property — over EVERY string in the alphabet, not a sample of it.
  describe('exhaustive round trip through CommandLineToArgvW', () => {
    it(`round-trips every string over {a, ${BS}, ", space, %} up to length ${MAX_ARG_LENGTH}`, () => {
      const cases = allStringsOverAlphabet(MAX_ARG_LENGTH);
      const failures = cases
        .filter(arg => !roundTrips(arg))
        .map(arg => ({
          arg,
          quoted: windowsShellQuote(arg),
          parsed: commandLineToArgv(`${windowsShellQuote(arg)} NEXT`),
        }));

      // Counts asserted, not just emptiness: a generator that silently produced nothing
      // would otherwise pass. 1 + 5 + 25 + 125 + 625 = 781.
      expect({ checked: cases.length, failed: failures.length, failures }).toEqual({
        checked: 781,
        failed: 0,
        failures: [],
      });
    });
  });

  // Named repros, so a regression reports WHICH input broke rather than a count.
  describe('regressions (each swallowed or corrupted an argument before the fix)', () => {
    it.each([
      { label: 'bare backslash-quote', arg: `${BS}"` },
      { label: 'backslash-quote after text', arg: `a${BS}"` },
      { label: 'run of two backslashes before a quote', arg: `a${BS}${BS}"b` },
      { label: 'prose with an escaped quote', arg: `say "hi${BS}" there` },
      { label: 'JSON carrying a Windows path', arg: `{"dir":"C:${BS.repeat(2)}tools${BS.repeat(2)}"}` },
      { label: 'trailing separator with a space', arg: `C:${BS}Program Files${BS}` },
    ])('$label round-trips and leaves the next argument alone', ({ arg }) => {
      expect(commandLineToArgv(`${windowsShellQuote(arg)} NEXT`)).toEqual([arg, 'NEXT']);
    });

    it(`the minimal repro: ${BS}" no longer absorbs the following argument`, () => {
      // Before: quoted as  "\"""  -> parsed as the single argument  `"" NEXT`.
      const quoted = windowsShellQuote(`${BS}"`);
      expect(quoted).toBe(`"${BS.repeat(3)}""`);
      expect(commandLineToArgv(`${quoted} NEXT`)).toEqual([`${BS}"`, 'NEXT']);
    });
  });
});

describe('buildWindowsShellLine', () => {
  it('joins the command token and quoted args', () => {
    expect(buildWindowsShellLine('claude', ['--version'])).toBe('claude --version');
  });

  it('keeps two args separate when the first ends in a backslash', () => {
    // Without doubling, the closing quote is escaped and `next` is absorbed into arg 1.
    expect(buildWindowsShellLine('mytool', [`C:${BS}Program Files${BS}`, 'next'])).toBe(
      `mytool "C:${BS}Program Files${BS}${BS}" next`,
    );
  });

  it('throws when commandToken contains whitespace and is not pre-quoted', () => {
    expect(() => buildWindowsShellLine(`C:${BS}Program Files${BS}tool.cmd`, ['a'])).toThrow(
      /commandToken/,
    );
  });

  it('accepts a pre-quoted commandToken containing whitespace', () => {
    expect(buildWindowsShellLine(`"C:${BS}Program Files${BS}tool.cmd"`, ['a'])).toBe(
      `"C:${BS}Program Files${BS}tool.cmd" a`,
    );
  });

  // The old predicate was `startsWith('"') && endsWith('"')`, which is true of an entire
  // crafted command line — so a multi-token string sailed through as "already quoted".
  describe('rejects a commandToken that is more than one cmd.exe token', () => {
    it.each([
      { label: 'a crafted line that only LOOKS quoted', token: '"a b" && calc "x"' },
      { label: 'two quoted tokens', token: '"a" "b"' },
      { label: 'a quoted token followed by an unquoted one', token: '"a b" c' },
      { label: 'quote-then-metachar', token: '"a"&calc' },
      { label: 'an unbalanced leading quote', token: '"a b' },
      { label: 'a lone quote', token: '"' },
      { label: 'an unquoted token carrying a metacharacter', token: 'calc&calc' },
      { label: 'an unquoted token carrying a pipe', token: 'tool|calc' },
      { label: 'an unquoted token with an interior quote', token: 'to"ol' },
    ])('$label', ({ token }) => {
      expect(() => buildWindowsShellLine(token, ['--v'])).toThrow(/commandToken/);
    });
  });

  it('still accepts the two legitimate shapes', () => {
    expect(buildWindowsShellLine('claude', ['--v'])).toBe('claude --v');
    expect(buildWindowsShellLine(`C:${BS}tools${BS}claude.cmd`, ['--v'])).toBe(
      `C:${BS}tools${BS}claude.cmd --v`,
    );
  });
});

describe('isPathLike', () => {
  it('is false for a bare PATH name', () => {
    expect(isPathLike('claude')).toBe(false);
    expect(isPathLike('npm')).toBe(false);
    expect(isPathLike('tool.cmd')).toBe(false);
  });

  it('is true for anything carrying a separator or a drive root, on either platform', () => {
    expect(isPathLike('/usr/local/bin/claude')).toBe(true);
    expect(isPathLike('./bin/tool.cmd')).toBe(true);
    expect(isPathLike(`C:${BS}npm${BS}claude.cmd`)).toBe(true);
    expect(isPathLike(`${BS}${BS}host${BS}share${BS}tool.cmd`)).toBe(true);
  });
});

describe('resolveShellCommandToken', () => {
  it('leaves a bare PATH name bare so cmd.exe re-resolves it via PATHEXT', () => {
    // Quoting (or substituting the resolved path) here would defeat the PATHEXT lookup.
    expect(resolveShellCommandToken('claude', `C:${BS}npm${BS}claude.cmd`)).toBe('claude');
  });

  it('passes a space-free explicit path through unquoted', () => {
    const explicit = `C:${BS}tools${BS}claude.cmd`;
    expect(resolveShellCommandToken(explicit, explicit)).toBe(explicit);
  });

  it('quotes an explicit path containing a space', () => {
    const explicit = `C:${BS}Program Files${BS}tool.cmd`;
    expect(resolveShellCommandToken(explicit, explicit)).toBe(`"${explicit}"`);
  });

  it('quotes the RESOLVED path, not the raw input', () => {
    // A relative explicit path is path-like, so it is used verbatim by the spawn
    // wrappers — but the token must come from the resolved value they actually launch.
    expect(resolveShellCommandToken('./bin/tool.cmd', `C:${BS}Program Files${BS}bin${BS}tool.cmd`))
      .toBe(`"C:${BS}Program Files${BS}bin${BS}tool.cmd"`);
  });

  // REPLACES an earlier test that fed a command path ending in a backslash
  // (`C:\Program Files\bin\`). That input is unreachable: this token is only built when
  // `shouldUseShell` is true, which requires a `.cmd`/`.bat`/`.ps1` suffix, so a resolved
  // command path can never end in a separator. It also modelled the wrong parser — the
  // command token is consumed by cmd.exe, which has no backslash escape at all. The
  // reachable property is the one below: the whole line splits back into the argv the
  // child process is supposed to see.
  it('produces a line whose argv is exactly [command, ...args] for a spacey .cmd path', () => {
    const resolved = `C:${BS}Program Files${BS}bin${BS}tool.cmd`;
    const token = resolveShellCommandToken(resolved, resolved);
    const line = buildWindowsShellLine(token, ['--version', `C:${BS}Program Files${BS}`, 'next']);

    expect(commandLineToArgv(line)).toEqual([
      resolved,
      '--version',
      `C:${BS}Program Files${BS}`,
      'next',
    ]);
  });

  it('produces a token buildWindowsShellLine always accepts for a spacey path', () => {
    const resolved = `C:${BS}Program Files${BS}tool.cmd`;
    expect(() =>
      buildWindowsShellLine(resolveShellCommandToken(resolved, resolved), ['a']),
    ).not.toThrow();
  });

  // The defect this helper exists to remove was two spawn wrappers each picking the token
  // their own way. Keyed on the shared CALL, so a future refactor cannot quietly reinstate
  // a private copy of the predicate in either file.
  it('is the only token-selection path in both spawn wrappers', () => {
    const srcDir = resolveFromImportMeta(import.meta.url, '..', 'src');

    for (const file of ['safe-exec.ts', 'spawn-hardened.ts']) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from srcDir
      const source = readFileSync(safePath.join(srcDir, file), 'utf8');
      expect(source, `${file} must select its shell command token via the shared helper`).toContain(
        'resolveShellCommandToken(command,',
      );
    }
  });
});

describe('shouldUseShell', () => {
  it.skipIf(onWindows)('is always false off Windows, even for a .cmd path', () => {
    // Off Windows the platform fast-path returns false regardless of extension.
    expect(shouldUseShell('/usr/local/bin/claude')).toBe(false);
    expect(shouldUseShell('/usr/local/bin/anything.cmd')).toBe(false);
    expect(shouldUseShell('/usr/local/bin/anything.bat')).toBe(false);
  });

  it('is false for real executables even on Windows', () => {
    expect(shouldUseShell('C:/Program Files/nodejs/node.exe')).toBe(false);
    expect(shouldUseShell('C:/tools/claude')).toBe(false);
  });

  it.skipIf(!onWindows)('is true for .cmd/.bat/.ps1 shims on Windows (case-insensitive)', () => {
    expect(shouldUseShell('C:/npm/claude.cmd')).toBe(true);
    expect(shouldUseShell('C:/npm/CLAUDE.CMD')).toBe(true);
    expect(shouldUseShell('C:/tools/thing.bat')).toBe(true);
    expect(shouldUseShell('C:/tools/thing.ps1')).toBe(true);
  });
});
