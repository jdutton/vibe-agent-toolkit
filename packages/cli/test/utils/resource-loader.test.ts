import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Shape returned by `importOriginal` — spread-only, so the keys stay opaque. */
type OriginalModule = Record<string, unknown>;

/**
 * Synthetic absolute paths, resolved rather than written as literals.
 *
 * The code under test resolves its path argument with `safePath.resolve`, and on
 * Windows that prepends the cwd's drive letter — `/project` becomes `D:/project`.
 * A literal constant does not, so the literal and the resolved form disagree, and
 * `safePath.relative` between a driveless and a drive-qualified path returns a
 * drive-absolute string instead of a subtree-relative one. Resolving here puts
 * both sides of every comparison on the same footing on every platform; on POSIX
 * `resolve` is the identity for these inputs, so the values are unchanged.
 */
const PROJECT_ROOT = safePath.resolve('/project');
const SUBTREE_PATH = safePath.resolve('/project/docs/guides');
const EXPLICIT_PATH = safePath.resolve('/explicit/path');
const MISSING_PATH = safePath.resolve('/project/docs/missing');
const INCLUDE_PATTERNS = ['docs/**/*.md'];
const EXCLUDE_PATTERNS = ['**/draft.md'];

/**
 * The subtree-scoped form of {@link DEFAULT_RESOURCE_INCLUDE} for SUBTREE_PATH.
 * Written out literally so the test states the expected globs rather than
 * re-deriving them with the same code under test.
 */
const SUBTREE_INCLUDE = [
  'docs/guides/**/*.md',
  'docs/guides/**/*.html',
  'docs/guides/**/*.htm',
];

const loadConfigMock = vi.fn();
const gitTrackerInitializeMock = vi.fn();
const gitTrackerGetStatsMock = vi.fn();
const registryCrawlMock = vi.fn();
/** Absolute paths the fake fs reports as existing directories. */
const existingDirectories = new Set<string>();
let lastRegistryOptions: Record<string, unknown> | undefined;
let lastCrawlOptions: Record<string, unknown> | undefined;

/**
 * The crawl options minus the population source.
 *
 * The tests below are about which include/exclude patterns a path argument
 * produces, and the projection lane — now the DEFAULT — installs a
 * `populationSource` alongside them. Stripping exactly that one key keeps these
 * assertions on their own subject while preserving `toEqual`'s guarantee that no
 * OTHER stray key crept in, which `objectContaining` would quietly give up.
 *
 * @returns The recorded options without `populationSource`, or `undefined`
 */
function crawlPatterns(): Record<string, unknown> | undefined {
  if (lastCrawlOptions === undefined) return undefined;
  const rest = { ...lastCrawlOptions };
  delete rest.populationSource;
  return rest;
}

vi.mock('node:fs', () => ({
  existsSync: (p: string): boolean => existingDirectories.has(p),
  statSync: (p: string): { isDirectory: () => boolean } => ({
    isDirectory: () => existingDirectories.has(p),
  }),
}));

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => ({
  ...(await importOriginal<OriginalModule>()),
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

vi.mock('../../src/utils/config-loader.js', () => ({
  loadConfig: (projectRoot: string): unknown => loadConfigMock(projectRoot),
}));

vi.mock('@vibe-agent-toolkit/utils/git', async (importOriginal) => ({
  ...(await importOriginal<OriginalModule>()),
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
import {
  loadResourcesWithConfig,
  RESOURCES_CRAWL_ENV,
  RESOURCES_CRAWL_PROJECTION,
  RESOURCES_CRAWL_WALK,
} from '../../src/utils/resource-loader.js';

function createTestLogger(): { logger: Logger; debugCalls: string[]; warnCalls: string[] } {
  const debugCalls: string[] = [];
  const warnCalls: string[] = [];
  const logger: Logger = {
    info: () => undefined,
    warn: (msg: string) => {
      warnCalls.push(msg);
    },
    error: () => undefined,
    debug: (msg: string) => {
      debugCalls.push(msg);
    },
  };
  return { logger, debugCalls, warnCalls };
}

describe('loadResourcesWithConfig', () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    gitTrackerInitializeMock.mockReset();
    gitTrackerGetStatsMock.mockReset();
    gitTrackerGetStatsMock.mockReturnValue({ cacheSize: 0 });
    registryCrawlMock.mockReset();
    existingDirectories.clear();
    existingDirectories.add(PROJECT_ROOT);
    existingDirectories.add(SUBTREE_PATH);
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

    expect(crawlPatterns()).toEqual({
      baseDir: PROJECT_ROOT,
      include: INCLUDE_PATTERNS,
      exclude: EXCLUDE_PATTERNS,
    });
    expect(result.scanPath).toBe(PROJECT_ROOT);
    expect(result.projectRoot).toBe(PROJECT_ROOT);
  });

  it('keeps config exclude patterns and scopes include to the subtree when pathArg is inside the project', async () => {
    loadConfigMock.mockReturnValue({
      resources: {
        include: INCLUDE_PATTERNS,
        exclude: EXCLUDE_PATTERNS,
      },
    });
    const { logger } = createTestLogger();

    const result = await loadResourcesWithConfig(SUBTREE_PATH, PROJECT_ROOT, logger);

    // baseDir stays at projectRoot so the config's root-relative globs evaluate
    // on the basis they were declared against; the path arg becomes an include
    // prefix instead of a new base.
    expect(crawlPatterns()).toEqual({
      baseDir: PROJECT_ROOT,
      include: SUBTREE_INCLUDE,
      exclude: EXCLUDE_PATTERNS,
    });
    expect(result.scanPath).toBe(SUBTREE_PATH);
    expect(result.projectRoot).toBe(PROJECT_ROOT);
  });

  it('still applies config exclude patterns when the pathArg IS the project root', async () => {
    loadConfigMock.mockReturnValue({ resources: { exclude: EXCLUDE_PATTERNS } });
    const { logger } = createTestLogger();

    await loadResourcesWithConfig(PROJECT_ROOT, PROJECT_ROOT, logger);

    expect(crawlPatterns()).toEqual({
      baseDir: PROJECT_ROOT,
      include: ['**/*.md', '**/*.html', '**/*.htm'],
      exclude: EXCLUDE_PATTERNS,
    });
  });

  it('scopes a relative pathArg against the project root', async () => {
    existingDirectories.add(safePath.resolve('docs'));
    loadConfigMock.mockReturnValue({ resources: { exclude: EXCLUDE_PATTERNS } });
    const { logger } = createTestLogger();

    await loadResourcesWithConfig('docs', safePath.resolve('.'), logger);

    expect(crawlPatterns()).toEqual({
      baseDir: safePath.resolve('.'),
      include: ['docs/**/*.md', 'docs/**/*.html', 'docs/**/*.htm'],
      exclude: EXCLUDE_PATTERNS,
    });
  });

  it('warns and drops config patterns only when pathArg escapes the project root', async () => {
    existingDirectories.add(EXPLICIT_PATH);
    loadConfigMock.mockReturnValue({
      resources: { include: INCLUDE_PATTERNS, exclude: EXCLUDE_PATTERNS },
    });
    const { logger, warnCalls } = createTestLogger();

    const result = await loadResourcesWithConfig(EXPLICIT_PATH, PROJECT_ROOT, logger);

    expect(crawlPatterns()).toEqual({ baseDir: EXPLICIT_PATH });
    expect(warnCalls.join('\n')).toContain(EXPLICIT_PATH);
    expect(result.scanPath).toBe(EXPLICIT_PATH);
  });

  it('fails loudly when pathArg is not an existing directory', async () => {
    loadConfigMock.mockReturnValue({ resources: { exclude: EXCLUDE_PATTERNS } });
    const { logger } = createTestLogger();

    await expect(
      loadResourcesWithConfig(MISSING_PATH, PROJECT_ROOT, logger),
    ).rejects.toThrow(MISSING_PATH);
    expect(lastCrawlOptions).toBeUndefined();
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

    expect(crawlPatterns()).toEqual({ baseDir: PROJECT_ROOT });
    expect(result.config).toBeUndefined();
  });

  it('reports the lane it actually took, and takes the PROJECTION by default', async () => {
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();

    const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger);

    expect(result.lane).toBe('projection');
    // The lane is a claim about what ran, so it has to agree with whether a
    // population source was actually installed on the crawl.
    expect(lastCrawlOptions?.populationSource).toBeDefined();
  });

  it('takes the walk when opted out, and says so', async () => {
    // A lane that came back `projection` here — or `walk` in the case above —
    // would make every arm-identity claim built on this field worthless, which
    // is precisely what it exists to prevent.
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();
    process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_WALK;

    try {
      const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger);

      expect(result.lane).toBe('walk');
      expect(lastCrawlOptions?.populationSource).toBeUndefined();
    } finally {
      delete process.env[RESOURCES_CRAWL_ENV];
    }
  });

  it('keeps honouring the historical explicit `projection` value', async () => {
    // The opt-in spelling predates the flip and is all over scripts and lab
    // arms. It must still select the projection lane rather than becoming an
    // unrecognised value that silently means something else.
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();
    process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_PROJECTION;

    try {
      const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger);

      expect(result.lane).toBe('projection');
    } finally {
      delete process.env[RESOURCES_CRAWL_ENV];
    }
  });

  it('logs debug messages for config load and gitTracker init', async () => {
    loadConfigMock.mockReturnValue({ resources: {} });
    gitTrackerGetStatsMock.mockReturnValue({ cacheSize: 42 });
    const { logger, debugCalls } = createTestLogger();

    await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger);

    expect(debugCalls).toContain(`Loaded config from ${PROJECT_ROOT}`);
    expect(debugCalls).toContain('GitTracker initialized with 42 tracked files');
  });
});
