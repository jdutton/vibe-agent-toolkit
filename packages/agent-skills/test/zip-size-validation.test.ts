/**
 * Unit tests for ZipSizeLimitError and validateZipSize.
 *
 * validateZipSize is an internal function called via packageSkill() when
 * target === 'claude-web' and 'zip' is in formats. This file uses vi.mock
 * to control statSync return values so we can test size thresholds without
 * creating real multi-megabyte ZIP files.
 *
 * Separated from skill-packager.test.ts because vi.mock() must be at the
 * module level in ESM — mixing with real-fs tests would break both.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with controlled temp dirs */
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ZipSizeLimitError, packageSkill } from '../src/skill-packager.js';

import { createFrontmatter } from './test-helpers.js';

// vi.mock is hoisted by vitest above all imports, so this runs before any
// module loads node:fs — preserving all real operations except statSync.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as typeof nodeFs;
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
  };
});

// ============================================================================
// Constants
// ============================================================================

/** 4 MB in bytes — ZIP size warning threshold */
const ZIP_WARN_BYTES = 4 * 1024 * 1024;
/** 8 MB in bytes — ZIP size error threshold */
const ZIP_ERROR_BYTES = 8 * 1024 * 1024;

const ZIP_SKILL_NAME = 'zip-size-test-skill';
/** Packaging target that enables ZIP size validation */
const CLAUDE_WEB = 'claude-web' as const;

// ============================================================================
// Setup — per-test temp directory
// ============================================================================

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(normalizedTmpdir(), 'zip-size-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ============================================================================
// Helpers
// ============================================================================

/** Write a minimal SKILL.md and return its path */
function writeSkillMd(dir: string, body: string): string {
  const skillPath = join(dir, 'SKILL.md');
  writeFileSync(skillPath, `${createFrontmatter({ name: ZIP_SKILL_NAME })}\n\n${body}`);
  return skillPath;
}

/** Options shared across claude-web ZIP packaging calls */
const CLAUDE_WEB_ZIP_FORMATS = ['directory', 'zip'] as const;

/**
 * Run packageSkill with claude-web target and a mocked statSync size.
 * Returns the result and a spy on process.stderr.write so callers can
 * assert whether a warning was emitted.
 */
async function runClaudeWebZipWithSize(
  scenario: string,
  fakeZipBytes: number,
): Promise<{ result: Awaited<ReturnType<typeof packageSkill>>; stderrSpy: ReturnType<typeof vi.spyOn> }> {
  const outDir = join(tempDir, `${scenario}-out`);
  const sp = writeSkillMd(tempDir, `# ${scenario}`);

  vi.mocked(nodeFs.statSync).mockReturnValue({ size: fakeZipBytes } as nodeFs.Stats);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  const result = await packageSkill(sp, {
    outputPath: outDir,
    formats: [...CLAUDE_WEB_ZIP_FORMATS],
    target: CLAUDE_WEB,
  });

  return { result, stderrSpy };
}

// ============================================================================
// ZipSizeLimitError — exported error class
// ============================================================================

describe('ZipSizeLimitError', () => {
  it('can be constructed with sizeBytes and limitBytes', () => {
    const sizeBytes = 9 * 1024 * 1024;
    const limitBytes = ZIP_ERROR_BYTES;
    const err = new ZipSizeLimitError(sizeBytes, limitBytes);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ZipSizeLimitError);
    expect(err.sizeBytes).toBe(sizeBytes);
    expect(err.limitBytes).toBe(limitBytes);
  });

  it('has name ZipSizeLimitError', () => {
    const err = new ZipSizeLimitError(9 * 1024 * 1024, ZIP_ERROR_BYTES);
    expect(err.name).toBe('ZipSizeLimitError');
  });

  it('includes human-readable size in MB and the 8MB limit in message', () => {
    // 9 * 1024 * 1024 bytes → 9.0MB
    const err = new ZipSizeLimitError(9 * 1024 * 1024, ZIP_ERROR_BYTES);
    expect(err.message).toContain('9.0MB');
    expect(err.message).toContain('8MB');
  });
});

// ============================================================================
// validateZipSize — exercised via packageSkill with claude-web target
// ============================================================================

describe('validateZipSize (via packageSkill, target: claude-web)', () => {
  it('throws ZipSizeLimitError when ZIP size is at the 8MB error threshold', async () => {
    const outDir = join(tempDir, 'zip-error-out');
    const sp = writeSkillMd(tempDir, '# Zip Error Test');

    vi.mocked(nodeFs.statSync).mockReturnValue({ size: ZIP_ERROR_BYTES } as nodeFs.Stats);

    await expect(
      packageSkill(sp, {
        outputPath: outDir,
        formats: [...CLAUDE_WEB_ZIP_FORMATS],
        target: CLAUDE_WEB,
      }),
    ).rejects.toThrow(ZipSizeLimitError);
  });

  it('throws ZipSizeLimitError when ZIP size exceeds 8MB', async () => {
    const outDir = join(tempDir, 'zip-over-out');
    const sp = writeSkillMd(tempDir, '# Zip Over Test');

    vi.mocked(nodeFs.statSync).mockReturnValue({
      size: ZIP_ERROR_BYTES + 1024,
    } as nodeFs.Stats);

    await expect(
      packageSkill(sp, {
        outputPath: outDir,
        formats: [...CLAUDE_WEB_ZIP_FORMATS],
        target: CLAUDE_WEB,
      }),
    ).rejects.toThrow(ZipSizeLimitError);
  });

  it('writes warning to stderr when ZIP size is in the [4MB, 8MB) range', async () => {
    // Test both the lower bound (4MB) and a mid-range value (6MB)
    const testSizes = [ZIP_WARN_BYTES, Math.floor((ZIP_WARN_BYTES + ZIP_ERROR_BYTES) / 2)];

    for (const size of testSizes) {
      vi.clearAllMocks();
      const { result, stderrSpy } = await runClaudeWebZipWithSize(`zip-warn-${size}`, size);
      expect(result.artifacts?.zip).toBeDefined();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('warning'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('8MB'));
    }
  });

  it('does nothing when ZIP size is below 4MB', async () => {
    const { result, stderrSpy } = await runClaudeWebZipWithSize('zip-ok', 1024);
    expect(result.artifacts?.zip).toBeDefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does not validate ZIP size for claude-code target', async () => {
    const outDir = join(tempDir, 'zip-code-out');
    const sp = writeSkillMd(tempDir, '# Claude Code Target');

    // Even with a huge fake size, claude-code should never call validateZipSize
    vi.mocked(nodeFs.statSync).mockReturnValue({ size: ZIP_ERROR_BYTES + 1024 } as nodeFs.Stats);

    const result = await packageSkill(sp, {
      outputPath: outDir,
      formats: [...CLAUDE_WEB_ZIP_FORMATS],
      target: 'claude-code',
    });

    // Should succeed — validateZipSize is not called for claude-code
    expect(result.artifacts?.zip).toBeDefined();
  });
});
