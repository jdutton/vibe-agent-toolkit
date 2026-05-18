import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ROOT = '/project';
const EXPLICIT_PATH = '/explicit/path';
const INCLUDE_PATTERNS = ['docs/**/*.md'];
const EXCLUDE_PATTERNS = ['**/draft.md'];

const loadConfigMock = vi.fn();
const gitTrackerInitializeMock = vi.fn();
const gitTrackerGetStatsMock = vi.fn();
const registryCrawlMock = vi.fn();
let lastRegistryOptions: Record<string, unknown> | undefined;
let lastCrawlOptions: Record<string, unknown> | undefined;

vi.mock('../../src/utils/config-loader.js', () => ({
  loadConfig: (projectRoot: string): unknown => loadConfigMock(projectRoot),
}));

vi.mock('@vibe-agent-toolkit/resources', () => ({
  ResourceRegistry: class {
    constructor(options: Record<string, unknown>) {
      lastRegistryOptions = options;
    }
    async crawl(options: Record<string, unknown>): Promise<void> {
      lastCrawlOptions = options;
      await registryCrawlMock(options);
    }
  },
}));

vi.mock('@vibe-agent-toolkit/utils', () => ({
  GitTracker: class {
    async initialize(): Promise<void> {
      await gitTrackerInitializeMock();
    }
    getStats(): { cacheSize: number } {
      return gitTrackerGetStatsMock();
    }
  },
}));

// eslint-disable-next-line import/first -- must come after vi.mock calls
import type { Logger } from '../../src/utils/logger.js';
// eslint-disable-next-line import/first -- must come after vi.mock calls
import { loadResourcesWithConfig } from '../../src/utils/resource-loader.js';

function createTestLogger(): { logger: Logger; debugCalls: string[] } {
  const debugCalls: string[] = [];
  const logger: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: (msg: string) => {
      debugCalls.push(msg);
    },
  };
  return { logger, debugCalls };
}

describe('loadResourcesWithConfig', () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    gitTrackerInitializeMock.mockReset();
    gitTrackerGetStatsMock.mockReset();
    gitTrackerGetStatsMock.mockReturnValue({ cacheSize: 0 });
    registryCrawlMock.mockReset();
    lastRegistryOptions = undefined;
    lastCrawlOptions = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses projectRoot as baseDir and applies config patterns when no pathArg', async () => {
    loadConfigMock.mockReturnValue({
      resources: {
        include: INCLUDE_PATTERNS,
        exclude: EXCLUDE_PATTERNS,
      },
    });
    const { logger } = createTestLogger();

    const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger);

    expect(lastCrawlOptions).toEqual({
      baseDir: PROJECT_ROOT,
      include: INCLUDE_PATTERNS,
      exclude: EXCLUDE_PATTERNS,
    });
    expect(result.scanPath).toBe(PROJECT_ROOT);
    expect(result.projectRoot).toBe(PROJECT_ROOT);
  });

  it('uses pathArg as baseDir and ignores config patterns when pathArg provided', async () => {
    loadConfigMock.mockReturnValue({
      resources: {
        include: INCLUDE_PATTERNS,
        exclude: EXCLUDE_PATTERNS,
      },
    });
    const { logger } = createTestLogger();

    const result = await loadResourcesWithConfig(EXPLICIT_PATH, PROJECT_ROOT, logger);

    expect(lastCrawlOptions).toEqual({ baseDir: EXPLICIT_PATH });
    expect(result.scanPath).toBe(EXPLICIT_PATH);
    expect(result.projectRoot).toBe(PROJECT_ROOT);
  });

  it('omits config from registry options when no collections', async () => {
    loadConfigMock.mockReturnValue({ resources: { include: ['**/*.md'] } });
    const { logger } = createTestLogger();

    await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger);

    expect(lastRegistryOptions).not.toHaveProperty('config');
    expect(lastRegistryOptions?.baseDir).toBe(PROJECT_ROOT);
  });

  it('passes config to registry options when collections present', async () => {
    const config = {
      resources: {
        collections: {
          systems: { include: ['docs/systems/**/*.md'] },
        },
      },
    };
    loadConfigMock.mockReturnValue(config);
    const { logger } = createTestLogger();

    await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger);

    expect(lastRegistryOptions?.config).toBe(config);
  });

  it('proceeds without config (no crash, no patterns applied)', async () => {
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();

    const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger);

    expect(lastCrawlOptions).toEqual({ baseDir: PROJECT_ROOT });
    expect(result.config).toBeUndefined();
  });

  it('logs debug messages for config load and gitTracker init', async () => {
    loadConfigMock.mockReturnValue({ resources: {} });
    gitTrackerGetStatsMock.mockReturnValue({ cacheSize: 42 });
    const { logger, debugCalls } = createTestLogger();

    await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger);

    expect(debugCalls).toContain('Loaded config from /project');
    expect(debugCalls).toContain('GitTracker initialized with 42 tracked files');
  });
});
