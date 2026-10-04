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
import yaml from 'yaml';

import { RAG_INDEX_REPORT_SCHEMA } from '../src/commands/rag/index-schema.js';
import { refusalCodeOf } from '../src/utils/command-refusal.js';
import { lazyAction, missingBackendError, type OptionalBackend } from '../src/utils/optional-backend.js';

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
  readonly stdout: string[];
  readonly exits: number[];
  restore: () => void;
} {
  const output: string[] = [];
  const stdoutChunks: string[] = [];
  const exits: number[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    stdoutChunks.push(String(chunk));
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
    stdout: stdoutChunks,
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

    const action = lazyAction('rag index', BACKEND, load);

    // Binding the action is what `createRagCommand` does at startup for every
    // subcommand. If that alone loaded the module, the whole seam would be a
    // no-op while still looking correct in the source.
    expect(load).not.toHaveBeenCalled();

    await action();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('passes the command arguments through to the loaded handler', async () => {
    const handler = vi.fn();
    const action = lazyAction('rag index', BACKEND, async () => handler);

    await action('docs/', { db: 'custom.db' });

    expect(handler).toHaveBeenCalledWith('docs/', { db: 'custom.db' });
  });

  it('rag index with an unavailable backend refuses with BACKEND_UNAVAILABLE, exit 2', async () => {
    const captured = captureExit();
    try {
      const action = lazyAction('rag index', BACKEND, (): Promise<() => unknown> => Promise.reject(moduleNotFound()));

      await expect(action()).rejects.toThrow('EXITED');

      // The verb's own published document, validated by its registry schema.
      const report = RAG_INDEX_REPORT_SCHEMA.parse(yaml.parse(captured.stdout.join('')));
      expect(report.status).toBe('error');
      expect(report).toMatchObject({ examined: 0, data: null, error: { code: 'BACKEND_UNAVAILABLE' } });
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
      const action = lazyAction('rag index', BACKEND, (): Promise<() => unknown> => Promise.reject(broken));

      await expect(action()).rejects.toThrow('Unexpected token in the backend');
      expect(captured.exits).toEqual([]);
      expect(captured.output.join('')).not.toContain('npm install');
    } finally {
      captured.restore();
    }
  });
});

/**
 * The backend chosen from inside a command (the projection store) cannot end
 * the process itself: it throws, and the verb's own catch publishes the
 * refusal in that verb's shape.
 */
describe('missingBackendError', () => {
  it('is a BACKEND_UNAVAILABLE refusal naming the package and the install command', () => {
    const error = missingBackendError(BACKEND);

    expect(refusalCodeOf(error)).toBe('BACKEND_UNAVAILABLE');
    expect(error.message).toContain('npm install @vibe-agent-toolkit/rag-lancedb');
    expect(error.message).toContain('RAG');
  });
});
