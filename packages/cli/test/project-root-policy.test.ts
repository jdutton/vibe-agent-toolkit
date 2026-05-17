import type * as UtilsModule from '@vibe-agent-toolkit/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Logger } from '../src/utils/logger.js';

// Mock the utils module so we can control findProjectRoot's return value.
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsModule>();
  return {
    ...actual,
    findProjectRoot: vi.fn<(startDir: string) => string | null>(),
  };
});

// Import AFTER vi.mock so the mocked findProjectRoot is in effect.
const { findProjectRoot } = await import('@vibe-agent-toolkit/utils');
const { requireProjectRoot, projectRootOrLoudCwd, projectRootOrNull } = await import(
  '../src/utils/project-root-policy.js'
);

function makeLogger(): Logger & {
  warnCalls: string[];
  infoCalls: string[];
  errorCalls: string[];
  debugCalls: string[];
} {
  const warnCalls: string[] = [];
  const infoCalls: string[] = [];
  const errorCalls: string[] = [];
  const debugCalls: string[] = [];
  return {
    warn: (m: string) => warnCalls.push(m),
    info: (m: string) => infoCalls.push(m),
    error: (m: string) => errorCalls.push(m),
    debug: (m: string) => debugCalls.push(m),
    warnCalls,
    infoCalls,
    errorCalls,
    debugCalls,
  };
}

const FAKE_PROJECT_ROOT = '/my/project';
const FAKE_NOWHERE_DIR = '/nowhere';

describe('requireProjectRoot', () => {
  beforeEach(() => {
    vi.mocked(findProjectRoot).mockReset();
  });

  it('returns the discovered root when one is found', () => {
    vi.mocked(findProjectRoot).mockReturnValue(FAKE_PROJECT_ROOT);
    expect(requireProjectRoot('/my/project/skill', 'vat skills build')).toBe(FAKE_PROJECT_ROOT);
  });

  it('throws when no root is found, with the documented message', () => {
    vi.mocked(findProjectRoot).mockReturnValue(null);
    expect(() => requireProjectRoot(FAKE_NOWHERE_DIR, 'vat skills build')).toThrow(
      /vat skills build requires a vibe-agent-toolkit\.config\.yaml or \.git\/ ancestor/,
    );
  });

  it('includes the command name in the error message', () => {
    vi.mocked(findProjectRoot).mockReturnValue(null);
    expect(() => requireProjectRoot(FAKE_NOWHERE_DIR, 'vat agent build')).toThrow(/vat agent build/);
  });
});

describe('projectRootOrLoudCwd', () => {
  beforeEach(() => {
    vi.mocked(findProjectRoot).mockReset();
  });

  it('returns the discovered root and does not warn when a root is found', () => {
    vi.mocked(findProjectRoot).mockReturnValue(FAKE_PROJECT_ROOT);
    const logger = makeLogger();
    expect(projectRootOrLoudCwd('/my/project/sub', logger)).toBe(FAKE_PROJECT_ROOT);
    expect(logger.warnCalls).toHaveLength(0);
  });

  it('falls back to the resolved startDir and warns exactly once when no root is found', () => {
    vi.mocked(findProjectRoot).mockReturnValue(null);
    const logger = makeLogger();
    const startDir = '/some/cwd';
    const result = projectRootOrLoudCwd(startDir, logger);
    // safePath.resolve on a posix-absolute path returns the same posix-style string.
    expect(result.endsWith(startDir) || result === startDir).toBe(true);
    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]).toMatch(
      /no vibe-agent-toolkit\.config\.yaml or \.git\/ ancestor found; using .* as projectRoot/,
    );
  });

  it('includes the cwd path in the warning message', () => {
    vi.mocked(findProjectRoot).mockReturnValue(null);
    const logger = makeLogger();
    const startDir = '/var/tmpXYZ/foo';
    projectRootOrLoudCwd(startDir, logger);
    expect(logger.warnCalls[0]).toContain(startDir);
  });
});

describe('projectRootOrNull', () => {
  beforeEach(() => {
    vi.mocked(findProjectRoot).mockReset();
  });

  it('passes through the root when one is found', () => {
    vi.mocked(findProjectRoot).mockReturnValue(FAKE_PROJECT_ROOT);
    expect(projectRootOrNull('/my/project/sub')).toBe(FAKE_PROJECT_ROOT);
  });

  it('passes through null when no root is found', () => {
    vi.mocked(findProjectRoot).mockReturnValue(null);
    expect(projectRootOrNull(FAKE_NOWHERE_DIR)).toBeNull();
  });
});
