import type { ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import { validateCommand } from '../../src/commands/skills/validate.js';
import {
  errorDiagnostics,
  formatDuration,
  handleCommandError,
  handleValidationGateFailure,
} from '../../src/utils/command-error.js';
import type { Logger } from '../../src/utils/logger.js';

const PROCESS_EXIT_ERROR_MESSAGE = 'process.exit called';

/** The line every failure envelope on stdout must open with. */
const STATUS_ERROR_LINE = 'status: error';

/**
 * A directory with no `vibe-agent-toolkit.config.yaml` and no `.git/` ancestor,
 * so every `required`-policy command throws at its very first step. Enough to
 * exercise the catch arm without staging a project.
 */
const ROOTLESS_DIR = normalizedTmpdir();

/** The subject name reused across the gate-failure cases. */
const GATE_SUBJECT = 'my-skill';

function issue(severity: ValidationIssue['severity'], code: string): ValidationIssue {
  return { code: code as ValidationIssue['code'], severity, message: `${code} happened` };
}

/**
 * Helper to extract YAML output from mock stdout writes
 * writeYamlOutput calls process.stdout.write 3 times
 */
function getYamlOutput(mockStdoutWrite: ReturnType<typeof vi.spyOn>): string {
  return mockStdoutWrite.mock.calls.map((call) => call[0]).join('');
}

describe('command-error utilities', () => {
  let mockLogger: Logger;
  let mockProcessExit: ReturnType<typeof vi.spyOn>;
  let mockStdoutWrite: ReturnType<typeof vi.spyOn>;
  let mockStderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockLogger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    mockProcessExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((): never => {
        throw new Error(PROCESS_EXIT_ERROR_MESSAGE);
      }) as unknown as ReturnType<typeof vi.spyOn>;
    mockStdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((): boolean => true) as unknown as ReturnType<typeof vi.spyOn>;
    // The real commands log progress to stderr; silenced so a suite run stays readable.
    mockStderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((): boolean => true) as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    mockProcessExit.mockRestore();
    mockStdoutWrite.mockRestore();
    mockStderrWrite.mockRestore();
  });

  describe('formatDuration', () => {
    it('should format milliseconds < 1000', () => {
      expect(formatDuration(0)).toBe('0ms');
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('should format seconds >= 1000ms', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(1500)).toBe('1.5s');
      expect(formatDuration(5500)).toBe('5.5s');
      expect(formatDuration(59999)).toBe('60.0s');
    });

    it('should format minutes >= 60s', () => {
      expect(formatDuration(60000)).toBe('1.0m');
      expect(formatDuration(90000)).toBe('1.5m');
      expect(formatDuration(150000)).toBe('2.5m');
    });
  });

  describe('errorDiagnostics', () => {
    it('returns the stack of an Error, not just its message', () => {
      const diagnostics = errorDiagnostics(new Error('boom'));
      expect(diagnostics).toContain('Error: boom');
      expect(diagnostics.split('\n').length).toBeGreaterThan(1);
    });

    it('falls back to name and message when an Error carries no stack', () => {
      // Cross-realm and hand-built errors reach here with `stack` undefined;
      // `stack` is optional in the type, so the fallback is not theoretical.
      const stackless = new RangeError('out of range');
      stackless.stack = undefined;
      expect(errorDiagnostics(stackless)).toBe('RangeError: out of range');
    });

    it('inspects a thrown non-Error rather than discarding it', () => {
      expect(errorDiagnostics({ code: 'ENOENT' })).toContain("code: 'ENOENT'");
      expect(errorDiagnostics('a bare string')).toContain('a bare string');
      expect(errorDiagnostics(undefined)).toContain('undefined');
    });
  });

  describe('handleCommandError', () => {
    it('should handle Error instances', () => {
      const error = new Error('Test error message');
      const startTime = Date.now();

      expect(() => handleCommandError(error, mockLogger, startTime, 'TestCommand')).toThrow(
        PROCESS_EXIT_ERROR_MESSAGE
      );

      expect(mockLogger.error).toHaveBeenCalledWith('TestCommand failed: Test error message');
      expect(mockProcessExit).toHaveBeenCalledWith(2);

      const yamlOutput = getYamlOutput(mockStdoutWrite);
      expect(yamlOutput).toContain(STATUS_ERROR_LINE);
      expect(yamlOutput).toContain('error: Test error message');
    });

    it('should handle non-Error values', () => {
      const error = 'String error';
      const startTime = Date.now();

      expect(() => handleCommandError(error, mockLogger, startTime, 'TestCommand')).toThrow(
        PROCESS_EXIT_ERROR_MESSAGE
      );

      expect(mockLogger.error).toHaveBeenCalledWith('TestCommand failed: Unknown error');
      expect(mockProcessExit).toHaveBeenCalledWith(2);

      const yamlOutput = getYamlOutput(mockStdoutWrite);
      expect(yamlOutput).toContain(STATUS_ERROR_LINE);
      expect(yamlOutput).toContain('error: Unknown error');
    });

    it('sends the stack to the debug channel, so --debug can name the throw site', () => {
      // The defect: exit 2 is the UNEXPECTED failure, and the envelope carried
      // `error.message` and nothing else. A real internal `TypeError` reached a
      // user as one line — no file, no frames — with no flag that would produce
      // them; the throw site was only found by hand-patching the built `dist`.
      const error = new TypeError("Cannot read properties of undefined (reading 'readdir')");
      expect(() => handleCommandError(error, mockLogger, Date.now(), 'TestCommand')).toThrow(
        PROCESS_EXIT_ERROR_MESSAGE,
      );

      const debugged = vi.mocked(mockLogger.debug).mock.calls.map((call) => call[0]).join('\n');
      expect(debugged).toContain("Cannot read properties of undefined (reading 'readdir')");
      // A frame is the whole point — the message alone was already on stderr.
      expect(debugged).toContain(`${import.meta.url.replace('file://', '')}:`);
    });

    it('names a non-Error throw on the debug channel, which the envelope calls "Unknown error"', () => {
      // `error: Unknown error` on stdout names neither the type nor the contents
      // of what was thrown — for a bare object it is the entire diagnosis.
      expect(() =>
        handleCommandError({ code: 'ENOENT', path: '/gone' }, mockLogger, Date.now(), 'TestCommand'),
      ).toThrow(PROCESS_EXIT_ERROR_MESSAGE);

      const debugged = vi.mocked(mockLogger.debug).mock.calls.map((call) => call[0]).join('\n');
      expect(debugged).toContain('ENOENT');
      expect(debugged).toContain('/gone');
    });

    it('should include formatted duration in output', () => {
      const error = new Error('Test error');
      const startTime = Date.now() - 1500; // 1.5 seconds ago

      expect(() => handleCommandError(error, mockLogger, startTime, 'TestCommand')).toThrow(
        PROCESS_EXIT_ERROR_MESSAGE
      );

      const yamlOutput = getYamlOutput(mockStdoutWrite);
      expect(yamlOutput).toMatch(/duration: \d+\.\d+s/);
    });
  });

  describe('the `skills` command family routes through this implementation', () => {
    it('emits the error envelope on stdout when `skills validate` fails', async () => {
      // The defect: `commands/skills/command-helpers.ts` shipped a SECOND
      // `handleCommandError` that logged to stderr and exited 2 having written
      // NOTHING to stdout — a `vat skills validate` failure produced 0 bytes of
      // the machine-readable document its own help text promises, while every
      // other command family (`resources/`, `rag/`, and `skills build` /
      // `skills package`) emitted the envelope. Two implementations, one
      // contract, two behaviours.
      await expect(validateCommand(ROOTLESS_DIR, {})).rejects.toThrow(PROCESS_EXIT_ERROR_MESSAGE);

      const yamlOutput = getYamlOutput(mockStdoutWrite);
      expect(yamlOutput).toContain(STATUS_ERROR_LINE);
      expect(yamlOutput).toContain('vat skills validate requires');
      expect(mockProcessExit).toHaveBeenCalledWith(2);
    });
  });

  describe('handleValidationGateFailure', () => {
    it('publishes the documented status + issueCounts before exiting 1', () => {
      // The defect: `skills build` and `skills package` exited 1 from their
      // validation gate having written 0 bytes to stdout, even though both
      // `--help` texts document a YAML summary on stdout and reserve exit 1 for
      // exactly this case. The consumer got an empty document and a bare code.
      expect(() =>
        handleValidationGateFailure(GATE_SUBJECT, [
          issue('error', 'E1'),
          issue('warning', 'W1'),
          issue('info', 'I1'),
        ]),
      ).toThrow(PROCESS_EXIT_ERROR_MESSAGE);

      const yamlOutput = getYamlOutput(mockStdoutWrite);
      expect(yamlOutput).toContain(STATUS_ERROR_LINE);
      expect(yamlOutput).toContain(`skill: ${GATE_SUBJECT}`);
      // The distribution has to travel beside the status: `status: error` alone
      // cannot say whether the run also carried warnings and info.
      expect(yamlOutput).toContain('errors: 1');
      expect(yamlOutput).toContain('warnings: 1');
      expect(yamlOutput).toContain('info: 1');
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('exits 1, not the 2 reserved for unexpected system errors', () => {
      expect(() => handleValidationGateFailure(GATE_SUBJECT, [issue('error', 'E1')])).toThrow(
        PROCESS_EXIT_ERROR_MESSAGE,
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(mockProcessExit).not.toHaveBeenCalledWith(2);
    });
  });
});
