import { ExitCode, reportSchema, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { validateCommand } from '../../src/commands/skills/validate.js';
import {
  exitCodeForCommanderEnding,
  formatDuration,
  handleCommandError,
  handleReportCommandError,
  handleReportExpectedFailure,
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

    it('honours --format json, so a JSON consumer can parse the failure', () => {
      // The shipped defect: every `--format json` command honoured the flag on
      // the SUCCESS path and emitted YAML here, so the one document a CI wrapper
      // most needs — the one saying why the command failed — arrived in a format
      // its parser rejects. The consumer got a parse error stacked on top of the
      // real error and had to guess at the second to find the first.
      expect(() => handleCommandError(new Error('Boom'), mockLogger, Date.now(), 'TestCommand', 'json'))
        .toThrow(PROCESS_EXIT_ERROR_MESSAGE);

      const written = getYamlOutput(mockStdoutWrite);
      // Parses as JSON, which is the whole claim — not merely "contains braces".
      const parsed = JSON.parse(written) as { status: string; error: string };
      expect(parsed.status).toBe('error');
      expect(parsed.error).toBe('Boom');
      expect(written).not.toContain(STATUS_ERROR_LINE);
    });

    it('stays YAML when the format is absent or anything but json', () => {
      expect(() => handleCommandError(new Error('Boom'), mockLogger, Date.now(), 'TestCommand', 'yaml'))
        .toThrow(PROCESS_EXIT_ERROR_MESSAGE);
      expect(getYamlOutput(mockStdoutWrite)).toContain(STATUS_ERROR_LINE);
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
      //
      // Matched as `<basename>:<line>` rather than against a path built from
      // `import.meta.url`. Stripping the `file://` prefix leaves `/D:/a/repo/...`
      // on Windows — forward slashes AND a leading slash — while the stack frame
      // carries the native `D:\a\repo\...`, so the two could never match there and
      // the test was green only on POSIX. This form also asserts strictly MORE
      // than the original did: a line number has to be present, not just a path.
      expect(debugged).toMatch(/command-error\.test\.ts:\d+/);
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

  describe('the envelope endings — the failure document IS the published schema', () => {
    // The strictest data schema an envelope command could declare: an error
    // document must pass it anyway, because `data` is null on that branch.
    const SCHEMA = reportSchema(z.object({ root: z.string() }).strict());

    it('handleReportCommandError publishes an error envelope the schema accepts, at ERROR', () => {
      expect(() => handleReportCommandError(new Error('Boom'), mockLogger, Date.now(), 'Envelope', 'json'))
        .toThrow(PROCESS_EXIT_ERROR_MESSAGE);

      const parsed = SCHEMA.safeParse(JSON.parse(getYamlOutput(mockStdoutWrite)));
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
      if (!parsed.success) return;
      expect(parsed.data.status).toBe('error');
      expect(parsed.data.error).toBe('Boom');
      expect(parsed.data.examined).toBe(0);
      expect(parsed.data.data).toBeNull();
      expect(mockProcessExit).toHaveBeenCalledWith(ExitCode.ERROR);
    });

    it('handleReportExpectedFailure publishes the error envelope at the code it DERIVES — ERROR — YAML by default', () => {
      // 🚨 It took the code from the caller, and `vat ard emit` passed FINDINGS
      // beside a document whose status said the command could not do its job.
      expect(() => handleReportExpectedFailure('no config file', Date.now()))
        .toThrow(PROCESS_EXIT_ERROR_MESSAGE);

      const yamlOutput = getYamlOutput(mockStdoutWrite);
      expect(yamlOutput).toContain(STATUS_ERROR_LINE);
      expect(yamlOutput).toContain('error: no config file');
      expect(yamlOutput).toContain('data: null');
      expect(mockProcessExit).toHaveBeenCalledWith(ExitCode.ERROR);
    });
  });
});

describe('exitCodeForCommanderEnding', () => {
  // Commander reports a SUCCESSFUL termination through the same error channel
  // as a failing one: `--help` and `--version` both end via `_exit(0, …)`.
  // Remapping those would turn every help page into a failing CI step.
  it('leaves a successful commander ending at 0', () => {
    expect(exitCodeForCommanderEnding(0)).toBe(0);
  });

  // The regression this whole mapping exists for. Commander's default for an
  // unknown option is exit 1 — which every command's `--help` publishes as
  // "at least one error-severity finding". `vat resources check --json` (the
  // option is `--format json`) therefore claimed a check had been violated
  // when nothing had run.
  it('remaps commander default 1 to ERROR, so a usage mistake is not read as a finding', () => {
    expect(exitCodeForCommanderEnding(1)).toBe(ExitCode.ERROR);
    expect(exitCodeForCommanderEnding(1)).not.toBe(ExitCode.FINDINGS);
  });

  // An unknown COMMAND arrives as code `commander.help` with a non-zero exit,
  // because the `command:*` handler renders help with `{ error: true }`. Any
  // non-zero ending is a usage mistake regardless of the code string, which is
  // why the exit code is the discriminator and the string is not.
  it('treats every non-zero commander ending as a usage mistake', () => {
    for (const code of [1, 2, 3, 64, 127]) {
      expect(exitCodeForCommanderEnding(code)).toBe(ExitCode.ERROR);
    }
  });
});
