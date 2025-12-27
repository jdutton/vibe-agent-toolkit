/**
 * Unit tests for common.ts utilities
 */
import { describe, expect, it } from 'vitest';

import { buildJscpdArgs, JSCPD_CONFIG } from '../src/common.js';

describe('buildJscpdArgs', () => {
  it('should build jscpd arguments with default output directory', () => {
    const args = buildJscpdArgs();

    expect(args).toContain('.');
    expect(args).toContain('--min-lines');
    expect(args).toContain(JSCPD_CONFIG.MIN_LINES);
    expect(args).toContain('--min-tokens');
    expect(args).toContain(JSCPD_CONFIG.MIN_TOKENS);
    expect(args).toContain('--reporters');
    expect(args).toContain('json');
    expect(args).toContain('--format');
    expect(args).toContain(JSCPD_CONFIG.FORMATS);
    expect(args).toContain('--ignore');
    expect(args).toContain(JSCPD_CONFIG.IGNORE_PATTERNS);
    expect(args).toContain('--output');
    expect(args).toContain(JSCPD_CONFIG.OUTPUT_DIR);
  });

  it('should build jscpd arguments with custom output directory', () => {
    const customDir = 'custom-output';
    const args = buildJscpdArgs(customDir);

    expect(args).toContain('--output');
    expect(args).toContain(customDir);
    expect(args).not.toContain(JSCPD_CONFIG.OUTPUT_DIR);
  });

  it('should include all required jscpd configuration', () => {
    const args = buildJscpdArgs();

    // Verify all key configuration options are present
    expect(args).toEqual([
      '.',
      '--min-lines', JSCPD_CONFIG.MIN_LINES,
      '--min-tokens', JSCPD_CONFIG.MIN_TOKENS,
      '--reporters', 'json',
      '--format', JSCPD_CONFIG.FORMATS,
      '--ignore', JSCPD_CONFIG.IGNORE_PATTERNS,
      '--output', JSCPD_CONFIG.OUTPUT_DIR,
    ]);
  });
});

describe('JSCPD_CONFIG', () => {
  it('should have expected configuration values', () => {
    expect(JSCPD_CONFIG.MIN_LINES).toBe('5');
    expect(JSCPD_CONFIG.MIN_TOKENS).toBe('50');
    expect(JSCPD_CONFIG.FORMATS).toBe('typescript,javascript');
    expect(JSCPD_CONFIG.OUTPUT_DIR).toBe('jscpd-report');
    expect(JSCPD_CONFIG.IGNORE_PATTERNS).toContain('node_modules');
    expect(JSCPD_CONFIG.IGNORE_PATTERNS).toContain('dist');
    expect(JSCPD_CONFIG.IGNORE_PATTERNS).toContain('coverage');
  });
});
