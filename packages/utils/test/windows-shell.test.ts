import { describe, expect, it } from 'vitest';

import { shouldUseShell, windowsShellQuote } from '../src/windows-shell.js';

const onWindows = process.platform === 'win32';

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

  it('doubles embedded double-quotes inside the wrap (cmd.exe escape form)', () => {
    expect(windowsShellQuote('a"b')).toBe('"a""b"');
  });

  it.each(['&', '|', '<', '>', '^', '(', ')', '%', '!'])(
    'quotes the cmd.exe metacharacter %s',
    metachar => {
      expect(windowsShellQuote(`a${metachar}b`)).toBe(`"a${metachar}b"`);
    },
  );
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
