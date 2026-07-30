/**
 * System test: YAML output must survive a PIPE, not just a terminal.
 *
 * Every YAML-emitting command writes via `writeYamlOutput` and then calls
 * `process.exit(0)` immediately. `process.stdout.write` is ASYNCHRONOUS when
 * stdout is a pipe, and `process.exit` does not wait for the pending write to
 * drain — so everything past the first pipe buffer (64 KB on Linux/macOS) was
 * silently dropped. Exit code stayed 0, so nothing signalled the loss.
 *
 * That breaks the contract this package's own docs advertise
 * (`vat command | jq .status`): a consumer parsing the piped document gets a
 * truncated one, cut mid-token. An interactive TTY is unbuffered and looked fine,
 * which is why it survived so long.
 *
 * `packages/cli/src/utils/help-loader.ts` already documented and solved exactly
 * this for `--help --verbose`; the fix simply never reached command output.
 *
 * The fixture must produce MORE than 64 KB, or the test passes vacuously against
 * the broken implementation — the whole point is to exceed one pipe buffer.
 */

import { afterEach, beforeAll, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  createSuiteContext,
  executeCli,
  expect,
  describe,
  join,
  fs,
  writeTestFile,
} from './test-common.js';

/** Node's pipe buffer on Linux/macOS. Output must exceed this to be a real test. */
const PIPE_BUFFER_BYTES = 65_536;

/**
 * Enough markdown files that `--verbose` (which emits a path/links/anchors/checksum
 * block per file) is comfortably past one pipe buffer. Each block runs ~150 bytes
 * plus the absolute path, so 700 files clears 64 KB several times over.
 */
const FILE_COUNT = 700;

const ctx = createSuiteContext('vat-stdout-pipe-', import.meta.url);

describe('YAML output survives a pipe (system)', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  it('emits a complete, parseable document larger than one pipe buffer', async () => {
    const tempDir = ctx.createTempDir();
    const projectDir = join(tempDir, 'many-docs');
    const docsDir = join(projectDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    writeTestFile(
      join(projectDir, 'vibe-agent-toolkit.config.yaml'),
      'version: 1\n',
    );
    for (let i = 0; i < FILE_COUNT; i++) {
      writeTestFile(
        join(docsDir, `doc-${String(i).padStart(4, '0')}.md`),
        `# Document ${i}\n\nBody text for document ${i}.\n`,
      );
    }

    // executeCli spawns with piped stdio — the exact condition that truncates.
    const result = await executeCli(
      ctx.binPath,
      ['resources', 'scan', '--verbose'],
      { cwd: projectDir },
    );

    expect(result.status).toBe(0);

    // Guard the fixture itself: if this ever drops below one buffer the assertions
    // below would pass against a broken implementation.
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeGreaterThan(PIPE_BUFFER_BYTES);

    // A truncated document is cut mid-token, so parsing is the sharpest check.
    const parsed = parseYaml(result.stdout) as {
      filesScanned: number;
      files: { path: string }[];
    };

    // Every file the command counted must actually appear in the emitted list —
    // truncation drops the tail while leaving the header (and its count) intact,
    // so comparing the two is what catches a partial write.
    expect(parsed.filesScanned).toBe(FILE_COUNT);
    expect(parsed.files).toHaveLength(FILE_COUNT);
  }, 120_000);
});
