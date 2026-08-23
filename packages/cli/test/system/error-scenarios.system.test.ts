import { it, beforeAll, afterAll } from 'vitest';

import { describe, expect, fs, getBinPath, safePath, spawnSync } from './test-common.js';
import {
  createTestTempDir,
  executeAndParseYaml,
  executeCli,
  setupTestProject,
  testConfigError,
} from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

/** How V8 indents every stack frame — a literal, so no regex backtracks over stderr. */
const V8_STACK_FRAME = '\n    at ';

describe('Error scenarios (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-error-test-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle invalid config file with exit code 2', () => {
    const result = testConfigError(
      tempDir,
      'invalid-config',
      'version: 999\n', // Invalid version
      binPath
    );

    expect(result.status).toBe(2); // System error
    expect(result.stderr).toContain('config');
  });

  it('should handle malformed YAML config', () => {
    const result = testConfigError(
      tempDir,
      'malformed-yaml',
      'version: 1\nresources:\n  - invalid: yaml: syntax:\n',
      binPath
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('config');
  });

  it('--debug reaches the subcommand and names the throw site of an exit-2 failure', () => {
    // Two defects, one line of evidence.
    //
    // 1. `--debug` is declared on the root program AND on 47 subcommands, and
    //    Commander resolves the root's definition first — so every action ran
    //    with `options.debug === undefined` and every `logger.debug(...)` in the
    //    CLI was unreachable through its own documented flag, wherever the flag
    //    sat on the command line.
    // 2. Exit 2 is the UNEXPECTED failure, and its envelope carried
    //    `error.message` alone. An internal `TypeError` reached users as one
    //    line with no file and no frames; the throw site was only ever found by
    //    hand-patching the built `dist`.
    const nonExistentPath = safePath.join(tempDir, 'never-created');

    const result = executeCli(binPath, ['resources', 'validate', nonExistentPath, '--debug']);

    expect(result.status).toBe(2);
    // NOT a bare `[DEBUG]`: `bin.ts` writes one such line from raw `process.argv`
    // before Commander parses, so that substring was present even when the flag
    // reached nothing. This line can only come from the subcommand's own logger.
    //
    // ⚠️ The marker used to be `[DEBUG] GitTracker initialized`. It moved because
    // the tracker is now initialized INSIDE the population-cache bracket — where a
    // git snapshot already answers its question, saving a `git ls-files` spawn —
    // and this scenario throws on the missing path BEFORE reaching that bracket.
    // So the old marker is genuinely absent here rather than broken, and swapping
    // it keeps what this test is actually about: a debug line that only the
    // subcommand's logger can have written.
    expect(result.stderr).toContain('[DEBUG] Path argument provided');
    // ...and the failure now carries frames, not just its message.
    expect(result.stderr).toContain('Error: Path does not exist');
    expect(result.stderr).toContain(V8_STACK_FRAME);
  });

  it('leaves stderr free of debug noise and stack frames without --debug', () => {
    const nonExistentPath = safePath.join(tempDir, 'never-created');

    const result = executeCli(binPath, ['resources', 'validate', nonExistentPath]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Path does not exist');
    expect(result.stderr).not.toContain('[DEBUG]');
    expect(result.stderr).not.toContain(V8_STACK_FRAME);
  });

  it('should handle non-existent directory path', () => {
    const nonExistentPath = safePath.join(tempDir, 'does-not-exist');

    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'scan', nonExistentPath]
    );

    expect(result.status).toBe(2);
    expect(parsed.status).toBe('error');
  });

  it('should handle empty directory gracefully', () => {
    const emptyDir = safePath.join(tempDir, 'empty');
    fs.mkdirSync(emptyDir);

    const { result, parsed } = executeAndParseYaml(binPath, ['resources', 'scan', emptyDir]);

    expect(result.status).toBe(0); // Empty is not an error
    expect(parsed.status).toBe('success');
    expect(parsed.filesScanned).toBe(0);
  });

  it('should handle markdown parse errors gracefully', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'parse-error',
      withDocs: true,
    });

    // Create technically valid but edge-case markdown
    fs.writeFileSync(
      safePath.join(projectDir, 'docs/weird.md'),
      '# Test\n\n[]()' // Empty link - valid markdown, but edge case
    );

    const result = spawnSync('node', [binPath, 'resources', 'scan', projectDir], {
      encoding: 'utf-8',
    });

    // Should not crash, might warn
    expect(result.status).toBe(0);
  });

  it('should exit with 1 when validation finds errors', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'validation-errors',
      withDocs: true,
    });

    fs.writeFileSync(
      safePath.join(projectDir, 'docs/test.md'),
      '# Test\n\n[Broken link](./missing.md)'
    );

    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'validate', projectDir]
    );

    expect(result.status).toBe(1); // Validation error, not system error
    expect(parsed.status).toBe('error');
    expect(parsed.errorsFound).toBeGreaterThan(0);
  });

  it('should handle debug flag correctly', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'debug-test',
      config: 'version: 1\n',
      withDocs: true,
    });

    fs.writeFileSync(safePath.join(projectDir, 'docs/test.md'), '# Test');

    const result = spawnSync('node', [binPath, 'resources', 'scan', projectDir, '--debug'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    // Unguarded, and paired with a negative control on the same fixture.
    // This was `if (stderr.includes('[DEBUG]')) { … }` asserting 'Scanning
    // path' — a string that exists nowhere in this codebase. With no debug
    // output the guard never fired, so an assertion that could never have
    // matched sat green. A conditional whose condition is always false is not
    // a test; the run WITHOUT --debug is what makes this one able to fail.
    //
    // A bare `[DEBUG]` still could not fail. `bin.ts` writes one `[DEBUG] stdio:`
    // line straight from `process.argv`, BEFORE Commander parses anything — so
    // that substring was present even while the flag never reached the command
    // and every logger.debug in the run was silent (measured: 1 line then, 5
    // now). Assert on a line only the SUBCOMMAND's own logger can write.
    expect(result.stderr).toContain('[DEBUG] Crawling ');

    const withoutDebug = spawnSync('node', [binPath, 'resources', 'scan', projectDir], {
      encoding: 'utf-8',
    });

    expect(withoutDebug.status).toBe(0);
    expect(withoutDebug.stderr).not.toContain('[DEBUG]');
  });

  it('should handle multiple validation errors', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'multiple-errors',
      withDocs: true,
    });

    // Create file with multiple broken links
    fs.writeFileSync(
      safePath.join(projectDir, 'docs/broken.md'),
      '# Test\n\n[Link 1](./missing1.md)\n[Link 2](./missing2.md)\n[Link 3](#bad-anchor)'
    );

    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'validate', projectDir]
    );

    expect(result.status).toBe(1);
    expect(parsed.errorsFound).toBeGreaterThanOrEqual(3);

    // Check errors are in structured output (not stderr by default)
    // Use text format to get stderr output
    const textResult = executeCli(binPath, ['resources', 'validate', projectDir, '--format', 'text']);
    expect(textResult.stderr).toContain('missing1.md');
    expect(textResult.stderr).toContain('missing2.md');
    expect(textResult.stderr).toContain('bad-anchor');
  });

  it('should handle circular links without crashing', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'circular',
      withDocs: true,
    });

    // Create circular references
    fs.writeFileSync(
      safePath.join(projectDir, 'docs/a.md'),
      '# A\n\n[Go to B](./b.md)'
    );
    fs.writeFileSync(
      safePath.join(projectDir, 'docs/b.md'),
      '# B\n\n[Go to A](./a.md)'
    );

    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'validate', projectDir]
    );

    // Should handle circular refs without infinite loop
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });
});
