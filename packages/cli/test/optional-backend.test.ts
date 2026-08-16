/**
 * `lazyAction` — the seam that keeps optional heavy backends out of startup.
 *
 * The behaviour under test is entirely about the FAILURE path, because the
 * success path is a plain `await import()` and would pass with or without this
 * module. What must not regress: a backend that is simply not installed
 * produces a legible instruction and exit 2, while any OTHER import failure —
 * a syntax error inside the backend, a throwing side effect — propagates
 * untouched. Collapsing those two would report "not installed" for a package
 * that is installed and broken, which is the worst diagnosis available.
 */

import { describe, expect, it, vi } from 'vitest';

import { lazyAction, type OptionalBackend } from '../src/utils/optional-backend.js';

const BACKEND: OptionalBackend = {
  feature: 'RAG',
  packageName: '@vibe-agent-toolkit/rag-lancedb',
};

/** Node's shape for an unresolvable specifier: the `code` is the contract. */
function moduleNotFound(): Error {
  const error = new Error("Cannot find package '@vibe-agent-toolkit/rag-lancedb'");
  (error as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';
  return error;
}

/** Capture stderr, stdout and `process.exit` for one call. */
function captureExit(): {
  readonly output: string[];
  readonly exits: number[];
  restore: () => void;
} {
  const output: string[] = [];
  const exits: number[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  // Throws rather than returns: `process.exit` is typed `never`, and a stub
  // that returned would let the code under test run on past its own exit.
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    throw new Error('EXITED');
  }) as never);
  return {
    output,
    exits,
    restore: () => {
      stderr.mockRestore();
      stdout.mockRestore();
      exit.mockRestore();
    },
  };
}

describe('lazyAction', () => {
  it('does not load the backend until the action actually runs', async () => {
    const load = vi.fn(async () => () => undefined);

    const action = lazyAction(BACKEND, load);

    // Binding the action is what `createRagCommand` does at startup for every
    // subcommand. If that alone loaded the module, the whole seam would be a
    // no-op while still looking correct in the source.
    expect(load).not.toHaveBeenCalled();

    await action();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('passes the command arguments through to the loaded handler', async () => {
    const handler = vi.fn();
    const action = lazyAction(BACKEND, async () => handler);

    await action('docs/', { db: 'custom.db' });

    expect(handler).toHaveBeenCalledWith('docs/', { db: 'custom.db' });
  });

  it('names the package to install, and exits 2, when the backend is absent', async () => {
    const captured = captureExit();
    try {
      const action = lazyAction(BACKEND, (): Promise<() => unknown> => Promise.reject(moduleNotFound()));

      await expect(action()).rejects.toThrow('EXITED');

      const all = captured.output.join('');
      expect(all).toContain('@vibe-agent-toolkit/rag-lancedb');
      expect(all).toContain('npm install');
      // Exit 2 is "system error", not 1: an absent optional package is a fact
      // about the installation, not about the user's corpus, and a script must
      // be able to tell those apart from the exit code alone.
      expect(captured.exits).toEqual([2]);
    } finally {
      captured.restore();
    }
  });

  it('CONTROL: rethrows an import failure that is NOT a missing module', async () => {
    // An installed-but-broken backend must not be reported as uninstalled —
    // the instruction "npm install it" would then be advice that cannot work.
    const captured = captureExit();
    try {
      const broken = new SyntaxError('Unexpected token in the backend');
      const action = lazyAction(BACKEND, (): Promise<() => unknown> => Promise.reject(broken));

      await expect(action()).rejects.toThrow('Unexpected token in the backend');
      expect(captured.exits).toEqual([]);
      expect(captured.output.join('')).not.toContain('npm install');
    } finally {
      captured.restore();
    }
  });
});
