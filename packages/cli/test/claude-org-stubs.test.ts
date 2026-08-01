import { describe, it, expect, afterEach, vi } from 'vitest';

import { writeNotYetImplementedStub } from '../src/commands/claude/org/stubs.js';

/** Capture everything the stub writes to stdout for one invocation. */
function captureStub(command: string): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    writeNotYetImplementedStub(command);
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeNotYetImplementedStub', () => {
  it('emits the machine-readable status and the command name', () => {
    const output = captureStub('org users update');

    expect(output).toContain('status: not-yet-implemented\n');
    expect(output).toContain('command: "org users update"\n');
  });

  /**
   * The stub used to promise `plannedFor: "0.1.22"` and "coming in the next
   * release". Both rot: every release that ships without the feature turns the
   * promise into a lie, and nothing in the build re-checks it. The message must
   * therefore be true at ANY future version — which means it must not name a
   * version or a release at all.
   */
  it('makes no dated promise: no version number and no release timeline', () => {
    const output = captureStub('org users update');

    // Bounded quantifiers: an unbounded `\d+\.\d+\.\d+` is a backtracking hazard
    // (sonarjs/slow-regex). Four digits per segment covers any real semver.
    expect(output).not.toMatch(/\d{1,4}\.\d{1,4}\.\d{1,4}/);
    expect(output).not.toMatch(/plannedFor/i);
    expect(output).not.toMatch(/next release|future release|coming (in|soon)/i);
  });

  it('emits valid YAML front-matter delimiters around the payload', () => {
    const output = captureStub('org api-keys update');

    expect(output.startsWith('---\n')).toBe(true);
    expect(output).toContain('command: "org api-keys update"\n');
  });
});
